/**
 * Permanent account deletion, scoped status receipts and durable bounded cleanup.
 * @packageDocumentation
 */

import { SignJWT, jwtVerify, base64url } from 'jose';
import type { Env } from './env.ts';
import {
  firebaseIdentity,
  lookupFirebaseAccount,
  deleteFirebaseAccount,
} from './firebaseAuth.ts';
import { PrivateError } from './privateError.ts';
import { privateRateLimit } from './privateRateLimit.ts';
import type { HeaderRequest } from './http.ts';

export const CLEANUP_CRON = '17 * * * *';
const RECEIPT_SECONDS = 3600;
const AUDIENCE = 'iris-account-deletion';

/** Durable deletion metadata; receipt claims contain only the random lifecycle ID. */
interface DeletionRow {
  deletion_id: string;
  deletion_at: number;
  state: 'deleting' | 'deleted';
}

/** Require an isolated signing key before accepting deletion work.
 * @param env - Environment-specific receipt key and project configuration.
 * @returns At least 256 bits of configured signing material.
 */
function receiptKey(env: Env) {
  if (
    !env.FIREBASE_PROJECT_ID ||
    !env.WATCHLIST_RECEIPT_KEY ||
    !/^[A-Za-z0-9_-]{43,}$/.test(env.WATCHLIST_RECEIPT_KEY)
  )
    throw new PrivateError('WATCHLIST_UNAVAILABLE', 503);
  const key = base64url.decode(env.WATCHLIST_RECEIPT_KEY);
  if (key.length < 32) throw new PrivateError('WATCHLIST_UNAVAILABLE', 503);
  return key;
}

/** Read status using a scoped receipt, including after normal authentication expires.
 * @param request - Receipt in Authorization, never in URLs or persistent storage.
 * @param env - Selected lifecycle database and signing configuration.
 * @returns Current lifecycle state without any UID or saved data.
 */
async function receiptStatus(request: HeaderRequest, env: Env) {
  const authorization = request.headers.get('authorization') ?? '';
  if (!authorization.startsWith('Deletion ') || authorization.length > 2048)
    throw new PrivateError('DELETION_RECEIPT_INVALID', 401);
  const key = receiptKey(env);
  let id: string;
  try {
    const { payload, protectedHeader } = await jwtVerify(
      authorization.slice(9),
      key,
      {
        algorithms: ['HS256'],
        issuer: env.FIREBASE_PROJECT_ID,
        audience: AUDIENCE,
        requiredClaims: ['jti', 'iat', 'exp'],
        maxTokenAge: RECEIPT_SECONDS,
      },
    );
    if (
      protectedHeader.typ !== 'iris-deletion+jwt' ||
      typeof payload.jti !== 'string' ||
      typeof payload.iat !== 'number' ||
      typeof payload.exp !== 'number' ||
      payload.exp - payload.iat !== RECEIPT_SECONDS
    )
      throw new Error('invalid');
    id = payload.jti;
  } catch {
    throw new PrivateError('DELETION_RECEIPT_INVALID', 401);
  }
  await privateRateLimit(env, `receipt:${id}`);
  const row = await env.WATCHLIST_DB?.prepare(
    "SELECT state FROM watchlist_accounts WHERE deletion_id = ? AND state IN ('deleting', 'deleted')",
  )
    .bind(id)
    .first<{ state: DeletionRow['state'] }>();
  if (!row) throw new PrivateError('DELETION_RECEIPT_INVALID', 401);
  return { status: row.state };
}

/** Accept irreversible deletion only after recent identity proof and a committed purge.
 * @param request - Empty-body account operation; explicit confirmation header required for acceptance.
 * @param env - Private bindings already checked by the route boundary.
 * @param statusOnly - Whether this operation is receipt-only status polling.
 * @returns Response status and the minimal lifecycle result.
 */
export async function accountDeletion(
  request: HeaderRequest,
  env: Env,
  statusOnly: boolean,
) {
  if (
    statusOnly ||
    request.headers.get('authorization')?.startsWith('Deletion ')
  )
    return { status: 200, data: await receiptStatus(request, env) };
  if (env.WATCHLIST_CLEANUP_ENABLED !== 'true')
    throw new PrivateError('WATCHLIST_UNAVAILABLE', 503);
  if (request.headers.get('x-iris-confirm-deletion') !== 'permanent')
    throw new PrivateError('DELETION_CONFIRMATION_REQUIRED', 400);
  const key = receiptKey(env);
  const { uid, authTime } = await firebaseIdentity(request, env, true);
  const db = env.WATCHLIST_DB;
  if (!db) throw new PrivateError('WATCHLIST_UNAVAILABLE', 503);
  const now = Math.floor(Date.now() / 1000);
  if (now - authTime > 300)
    throw new PrivateError('REAUTHENTICATION_REQUIRED', 403);
  const deletionId = crypto.randomUUID();
  const result = await db.batch<DeletionRow>([
    db
      .prepare(
        'INSERT INTO watchlist_accounts(uid) VALUES (?) ON CONFLICT(uid) DO NOTHING',
      )
      .bind(uid),
    db
      .prepare(
        "UPDATE watchlist_accounts SET state = 'deleting', deletion_id = ?, deletion_at = ?, next_attempt_at = ? WHERE uid = ? AND state = 'active'",
      )
      .bind(deletionId, now, now, uid),
    db
      .prepare(
        "DELETE FROM watchlist_items WHERE owner_uid = ? AND EXISTS (SELECT 1 FROM watchlist_accounts WHERE uid = ? AND state != 'active')",
      )
      .bind(uid, uid),
    db
      .prepare(
        "SELECT deletion_id, deletion_at, state FROM watchlist_accounts WHERE uid = ? AND state IN ('deleting', 'deleted')",
      )
      .bind(uid),
  ]);
  const row = result[3].results[0];
  if (!row?.deletion_id || !row.deletion_at)
    throw new PrivateError('WATCHLIST_UNAVAILABLE', 503);
  const receipt = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256', typ: 'iris-deletion+jwt' })
    .setIssuer(env.FIREBASE_PROJECT_ID ?? '')
    .setAudience(AUDIENCE)
    .setJti(row.deletion_id)
    .setIssuedAt(row.deletion_at)
    .setExpirationTime(row.deletion_at + RECEIPT_SECONDS)
    .sign(key);
  return {
    status: 202,
    data: {
      status: row.state,
      receipt,
      expiresAt: new Date(
        (row.deletion_at + RECEIPT_SECONDS) * 1000,
      ).toISOString(),
    },
  };
}

/** Retry durable deletion jobs, scan orphans fairly, then retire completed 31-day markers.
 * @param env - Isolated D1 and privileged Firebase identity; no browser credentials used.
 */
export async function cleanupAccounts(env: Env) {
  if (env.WATCHLIST_CLEANUP_ENABLED !== 'true') return;
  const db = env.WATCHLIST_DB;
  if (
    !db ||
    !env.FIREBASE_PROJECT_ID ||
    !env.FIREBASE_CLIENT_EMAIL ||
    !env.FIREBASE_PRIVATE_KEY
  )
    throw new PrivateError('WATCHLIST_UNAVAILABLE', 503);
  const now = Math.floor(Date.now() / 1000);
  // A durable five-minute lease also bounds overlapping scheduled invocations.
  const jobs = await db
    .prepare(
      "UPDATE watchlist_accounts SET next_attempt_at = ?, attempts = MIN(attempts + 1, 1000000) WHERE uid IN (SELECT uid FROM watchlist_accounts WHERE state = 'deleting' AND next_attempt_at <= ? ORDER BY next_attempt_at, uid LIMIT 10) RETURNING uid, attempts",
    )
    .bind(now + 300, now)
    .all<{ uid: string; attempts: number }>();
  let failures = 0;
  for (const job of jobs.results) {
    try {
      if (await lookupFirebaseAccount(env, job.uid))
        await deleteFirebaseAccount(env, job.uid);
      await db
        .prepare(
          "UPDATE watchlist_accounts SET state = 'deleted', completed_at = ? WHERE uid = ? AND state = 'deleting'",
        )
        .bind(now, job.uid)
        .run();
    } catch {
      failures++;
      await db
        .prepare(
          "UPDATE watchlist_accounts SET next_attempt_at = ? WHERE uid = ? AND state = 'deleting'",
        )
        .bind(
          now + Math.min(86400, 60 * 2 ** Math.min(job.attempts, 11)),
          job.uid,
        )
        .run();
    }
  }
  const accounts = await db
    .prepare(
      "UPDATE watchlist_accounts SET checked_at = ? WHERE uid IN (SELECT uid FROM watchlist_accounts WHERE state = 'active' AND checked_at <= ? ORDER BY checked_at, uid LIMIT 10) RETURNING uid",
    )
    .bind(now, now - 300)
    .all<{ uid: string }>();
  for (const account of accounts.results) {
    try {
      if (await lookupFirebaseAccount(env, account.uid)) continue;
      await db.batch([
        db
          .prepare(
            "UPDATE watchlist_accounts SET state = 'deleted', completed_at = ? WHERE uid = ? AND state = 'active'",
          )
          .bind(now, account.uid),
        db
          .prepare(
            "DELETE FROM watchlist_items WHERE owner_uid = ? AND EXISTS (SELECT 1 FROM watchlist_accounts WHERE uid = ? AND state != 'active')",
          )
          .bind(account.uid, account.uid),
      ]);
    } catch {
      failures++;
    }
  }
  await db
    .prepare(
      "DELETE FROM watchlist_accounts WHERE uid IN (SELECT uid FROM watchlist_accounts WHERE state = 'deleted' AND completed_at <= ? ORDER BY completed_at LIMIT 100)",
    )
    .bind(now - 31 * 86400)
    .run();
  if (failures) throw new PrivateError('ACCOUNT_CLEANUP_INCOMPLETE', 503);
}
