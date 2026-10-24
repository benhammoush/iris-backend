/**
 * Firebase token verification and configuration-scoped authentication caches.
 * @packageDocumentation
 */

import {
  decodeProtectedHeader,
  importPKCS8,
  importX509,
  jwtVerify,
  SignJWT,
} from 'jose';
import type { Env } from './env.ts';
import { record } from './record.ts';
import { PrivateError } from './privateError.ts';
import { singleFlight } from './singleFlight.ts';
import { privateRateLimit } from './privateRateLimit.ts';

const CERTS =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const TOKEN = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/identitytoolkit';
/** Represent unavailable data or configuration without treating it as an empty successful result. */
const unavailable = () => new PrivateError('AUTH_UNAVAILABLE', 503);
/** Construct the fixed error for an invalid boundary value. */
const invalid = () => new PrivateError('AUTH_INVALID', 401);

/** Authentication material scoped to one binding object and effective Firebase configuration. */
interface AuthCache {
  certs?: Record<string, unknown>;
  certsUntil: number;
  fetchedAt: number;
  accessToken?: string;
  tokenUntil: number;
  configuration: string[];
}
const caches = new WeakMap<Env, AuthCache>();

/** Reuse authentication state only for the same binding object and unchanged Firebase configuration. */
function cacheFor(env: Env): AuthCache {
  const configuration = [
    env.FIREBASE_PROJECT_ID ?? '',
    env.FIREBASE_CLIENT_EMAIL ?? '',
    env.FIREBASE_PRIVATE_KEY ?? '',
  ];
  let cache = caches.get(env);
  if (!cache || configuration.join('\0') !== cache.configuration.join('\0')) {
    cache = { certsUntil: 0, fetchedAt: 0, tokenUntil: 0, configuration };
    caches.set(env, cache);
  }
  return cache;
}

/** Fixed upstream endpoints, bounded bodies/deadlines, and no raw errors in logs. */
async function boundedJson(url: string, init?: RequestInit) {
  const response = await fetch(url, {
    ...init,
    redirect: 'manual',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw unavailable();
  const reader = response.body?.getReader();
  if (!reader) throw unavailable();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) throw unavailable();
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return {
    response,
    data: record(JSON.parse(new TextDecoder().decode(bytes))),
  };
}

/** Exchange a signed service-account assertion and cache the token with an expiry safety margin. */
async function accessTokenWork(env: Env, cache: AuthCache): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cache.accessToken && cache.tokenUntil > now) return cache.accessToken;
  if (!env.FIREBASE_PRIVATE_KEY || !env.FIREBASE_CLIENT_EMAIL)
    throw unavailable();
  const key = await importPKCS8(env.FIREBASE_PRIVATE_KEY, 'RS256');
  const assertion = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(env.FIREBASE_CLIENT_EMAIL)
    .setAudience(TOKEN)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);
  const { data } = await boundedJson(TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (
    typeof data.access_token !== 'string' ||
    !data.access_token ||
    data.token_type !== 'Bearer' ||
    typeof data.expires_in !== 'number' ||
    !Number.isFinite(data.expires_in) ||
    data.expires_in <= 60
  )
    throw unavailable();
  cache.accessToken = data.access_token;
  cache.tokenUntil = now + Math.min(data.expires_in, 3600) - 60;
  return cache.accessToken;
}

/** Coalesce concurrent service-account token refreshes within this authentication cache. */
function accessToken(env: Env, cache: AuthCache) {
  return singleFlight(cache, ['firebase-oauth'], () =>
    accessTokenWork(env, cache),
  );
}

/** Verify the Firebase bearer token and return its subject; reject invalid or unavailable authentication. */
export async function authenticateFirebase(
  request: { headers: Pick<Headers, 'get'> },
  env: Env,
): Promise<string> {
  const authorization = request.headers.get('authorization');
  if (!authorization) throw new PrivateError('AUTH_REQUIRED', 401);
  if (
    authorization.length > 8192 ||
    !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(
      authorization,
    )
  )
    throw invalid();
  const token = authorization.slice(7);
  const project = env.FIREBASE_PROJECT_ID;
  if (!project || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project))
    throw unavailable();
  const cache = cacheFor(env);
  const nowMs = Date.now();
  let header;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    throw invalid();
  }
  if (
    header.alg !== 'RS256' ||
    typeof header.kid !== 'string' ||
    !header.kid ||
    header.kid.length > 128 ||
    header.jku ||
    header.x5u
  )
    throw invalid();
  try {
    if (
      !cache.certs ||
      cache.certsUntil <= nowMs ||
      (!(header.kid in cache.certs) && nowMs - cache.fetchedAt >= 30000)
    ) {
      await singleFlight(cache, ['firebase-certificates'], async () => {
        const { data, response } = await boundedJson(CERTS);
        const seconds = Number(
          response.headers
            .get('cache-control')
            ?.match(/(?:^|[,\s])max-age=(\d+)/)?.[1] ?? 0,
        );
        cache.certs = data;
        cache.fetchedAt = nowMs;
        cache.certsUntil = nowMs + Math.min(seconds, 21600) * 1000;
      });
    }
  } catch {
    throw unavailable();
  }
  if (!cache.certs) throw unavailable();
  const cert = Object.hasOwn(cache.certs, header.kid)
    ? cache.certs[header.kid]
    : undefined;
  if (typeof cert !== 'string') throw invalid();
  let key;
  try {
    key = await importX509(cert, 'RS256');
  } catch {
    throw unavailable();
  }
  let payload;
  try {
    ({ payload } = await jwtVerify(token, key, {
      algorithms: ['RS256'],
      audience: project,
      issuer: `https://securetoken.google.com/${project}`,
      requiredClaims: ['sub', 'iat', 'exp', 'auth_time'],
      clockTolerance: 5,
    }));
  } catch {
    throw invalid();
  }
  const now = Math.floor(nowMs / 1000);
  if (
    typeof payload.sub !== 'string' ||
    !payload.sub.trim() ||
    payload.sub.length > 128 ||
    typeof payload.iat !== 'number' ||
    payload.iat > now + 5 ||
    typeof payload.auth_time !== 'number' ||
    !Number.isFinite(payload.auth_time) ||
    payload.auth_time > now + 5 ||
    payload.auth_time < 0
  )
    throw invalid();
  try {
    await privateRateLimit(env, `uid:${payload.sub}`);
    const adminToken = await accessToken(env, cache);
    const { data } = await boundedJson(
      `https://identitytoolkit.googleapis.com/v1/projects/${project}/accounts:lookup`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ localId: [payload.sub] }),
      },
    );
    if (!Array.isArray(data.users)) throw unavailable();
    if (!data.users.length) throw invalid();
    if (data.users.length !== 1) throw unavailable();
    const user = record(data.users[0]);
    if (user.localId !== payload.sub) throw unavailable();
    if (user.disabled === true) throw invalid();
    if (user.disabled !== undefined && typeof user.disabled !== 'boolean')
      throw unavailable();
    const validSince =
      user.validSince === undefined ? 0 : Number(user.validSince);
    if (!Number.isFinite(validSince) || validSince < 0) throw unavailable();
    if (payload.auth_time < validSince) throw invalid();
    if (user.emailVerified !== true)
      throw new PrivateError('EMAIL_VERIFICATION_REQUIRED', 403);
    return payload.sub;
  } catch (cause) {
    if (cause instanceof PrivateError) throw cause;
    throw unavailable();
  }
}
