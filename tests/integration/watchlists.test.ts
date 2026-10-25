/**
 * Regression coverage and controlled fixtures for watchlists.
 * @packageDocumentation
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import {
  Miniflare,
  convertV4MiniflareOptions,
  Response as MFResponse,
} from 'miniflare';
import { importPKCS8, importX509, SignJWT, jwtVerify } from 'jose';
import { privateKey, certificate } from '../support/watchlistKeys.ts';
import worker from '../../src/index.ts';
import { SOL_MINT } from '../../src/constants.ts';
import type { Env } from '../../src/env.ts';
import { authenticateFirebase } from '../../src/firebaseAuth.ts';
import { PrivateError } from '../../src/privateError.ts';
import { record } from '../../src/record.ts';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const project = 'iris-test-project';
const key = await importPKCS8(privateKey, 'RS256');
const publicKey = await importX509(certificate, 'RS256');
const contract = record(
  parse(await readFile(new URL('../../openapi.yaml', import.meta.url), 'utf8')),
);
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({
  $id: 'https://watchlist.test/contract',
  components: { schemas: record(contract.components).schemas },
});
/** Validate the fixture against the contract exercised by this test.
 * @param name - Declared contract schema name.
 * @param body - Actual response payload requiring runtime schema validation.
 */
function validate(name: string, body: unknown) {
  const check = ajv.compile({
    $ref: `https://watchlist.test/contract#/components/schemas/${name}`,
  });
  assert.ok(check(body), ajv.errorsText(check.errors));
}
/** Read current epoch seconds for the test token expiry fields.
 * @returns Current Unix time in whole seconds.
 */
const now = () => Math.floor(Date.now() / 1000);
/** Create the controlled authentication token used by the test.
 * @param uid - Subject identity to sign.
 * @param overrides - Controlled claim overrides, including invalid-claim fixtures.
 * @param kid - Signing-key identifier selected by the fixture.
 * @returns A signed token using the isolated test key only.
 */
async function token(
  uid = 'alice',
  overrides: Record<string, unknown> = {},
  kid = 'test-key',
) {
  return new SignJWT({
    sub: uid,
    iat: now(),
    exp: now() + 3600,
    auth_time: now() - 1,
    iss: `https://securetoken.google.com/${project}`,
    aud: project,
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256', kid })
    .sign(key);
}
/** Build isolated environment bindings for the exercised request.
 * @returns Empty cache bindings and isolated test-only authentication configuration.
 */
function env(): Env {
  return {
    SNAPSHOTS: {
      /** Read an absent cache entry.
       * @returns Null for every cache identity.
       */
      get: () => Promise.resolve(null),
      /** Observe or simulate the cache write requested by this test. */
      put: async () => {},
    },
    FIREBASE_PROJECT_ID: project,
    FIREBASE_CLIENT_EMAIL: 'test@iris-test-project.iam.gserviceaccount.com',
    FIREBASE_PRIVATE_KEY: privateKey,
    WATCHLIST_RATE_LIMITER: {
      /** Allow the isolated request budget.
       * @returns A successful limiter decision.
       */
      limit: () => Promise.resolve({ success: true }),
    },
  };
}

void test('Firebase rejects invalid signed claims without an account lookup', async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', (input: string | URL | Request) => {
    calls.push(input instanceof Request ? input.url : input.toString());
    return Promise.resolve(
      Response.json(
        { 'test-key': certificate },
        { headers: { 'cache-control': 'public, max-age=3600' } },
      ),
    );
  });
  const configuration = env();
  const invalidTokens = [
    await token('alice', { aud: 'other-project' }),
    await token('alice', { iss: 'https://evil.test' }),
    await token('alice', { exp: now() - 60 }),
    await token('alice', { nbf: now() + 60 }),
    await token('alice', { iat: now() + 60 }),
    await token('alice', { auth_time: now() + 60 }),
    await token(''),
    await token('a'.repeat(129)),
    await token('alice', { auth_time: null }),
    await token('alice', { exp: undefined }),
    await token('alice', { iat: undefined }),
    await token('alice', {}, 'unknown'),
    `${(await token()).slice(0, -10)}invalidsig`,
    'eyJhbGciOiJub25lIn0.eyJzdWIiOiJhbGljZSJ9.',
  ];
  for (const signed of invalidTokens) {
    await assert.rejects(
      authenticateFirebase(
        { headers: new Headers({ authorization: `Bearer ${signed}` }) },
        configuration,
      ),
      (cause: unknown) => cause instanceof PrivateError && cause.status === 401,
    );
  }
  assert.equal(
    calls.length,
    1,
    'known and unknown keys share bounded cert cache',
  );
  await assert.rejects(
    authenticateFirebase({ headers: new Headers() }, configuration),
    { code: 'AUTH_REQUIRED' },
  );
  await assert.rejects(
    authenticateFirebase(
      { headers: new Headers({ authorization: 'Bearer ' + 'x'.repeat(8192) }) },
      configuration,
    ),
    { code: 'AUTH_INVALID' },
  );
});

void test('certificate rotation/configuration scope and upstream failures fail closed', async (t) => {
  let certificateCalls = 0;
  let lookupCalls = 0;
  let phase: 'normal' | 'oversize' | 'redirect' | 'malformed' = 'normal';
  t.mock.method(globalThis, 'fetch', (input: string | URL | Request) =>
    Promise.resolve().then(() => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.hostname === 'www.googleapis.com') {
        certificateCalls++;
        if (phase === 'oversize') return new Response('x'.repeat(65537));
        if (phase === 'redirect')
          return new Response(null, {
            status: 302,
            headers: { location: 'https://evil.test' },
          });
        if (phase === 'malformed') return new Response('{not json');
        return Response.json(
          { 'test-key': certificate, rotated: certificate },
          { headers: { 'cache-control': 'max-age=0' } },
        );
      }
      if (url.hostname === 'oauth2.googleapis.com')
        return Response.json({
          access_token: 'test-admin',
          token_type: 'Bearer',
          expires_in: 3600,
        });
      lookupCalls++;
      return Response.json({
        users: [{ localId: 'alice', emailVerified: true, validSince: '0' }],
      });
    }),
  );
  const configuration = env();
  /** Build the request headers required by the exercised fixture.
   * @param signed - Controlled signed token, including invalid-token fixtures.
   * @returns The minimal authentication request boundary.
   */
  const headers = (signed: string) => ({
    headers: new Headers({ authorization: `Bearer ${signed}` }),
  });
  assert.equal(
    await authenticateFirebase(headers(await token()), configuration),
    'alice',
  );
  assert.equal(
    await authenticateFirebase(
      headers(await token('alice', {}, 'rotated')),
      configuration,
    ),
    'alice',
  );
  assert.equal(certificateCalls, 2, 'expired certificate cache must refresh');
  assert.equal(lookupCalls, 2, 'account status is never cached');
  const oldCalls = lookupCalls;
  configuration.FIREBASE_PROJECT_ID = 'other-project';
  await assert.rejects(
    authenticateFirebase(headers(await token()), configuration),
    { code: 'AUTH_INVALID' },
  );
  assert.equal(
    lookupCalls,
    oldCalls,
    'project configuration change must not reuse trust',
  );
  for (const failure of ['oversize', 'redirect', 'malformed'] as const) {
    phase = failure;
    await assert.rejects(authenticateFirebase(headers(await token()), env()), {
      code: 'AUTH_UNAVAILABLE',
    });
  }
  phase = 'normal';
  const limited = env();
  limited.WATCHLIST_RATE_LIMITER = {
    /** Deny the isolated request budget.
     * @returns A failed limiter decision before privileged account lookup.
     */
    limit: () => Promise.resolve({ success: false }),
  };
  await assert.rejects(authenticateFirebase(headers(await token()), limited), {
    code: 'RATE_LIMITED',
  });
  assert.equal(
    lookupCalls,
    oldCalls,
    'UID limit must precede privileged lookup',
  );
});

void test('workerd private routes enforce identity, real D1 constraints and public isolation', async (t) => {
  const bundled = await build({
    entryPoints: ['src/index.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
  });
  const lookups: string[] = [];
  const upstreamCalls: string[] = [];
  let upstreamFailure = false;
  let releaseRacingLookup: (() => void) | undefined;
  let observeRacingLookup: (() => void) | undefined;
  let user: Record<string, unknown> = { emailVerified: true, validSince: '0' };
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundled.outputFiles[0].text,
      compatibilityDate: '2026-10-02',
      kvNamespaces: ['SNAPSHOTS'],
      d1Databases: ['WATCHLIST_DB'],
      ratelimits: {
        WATCHLIST_RATE_LIMITER: {
          namespace_id: '1',
          simple: { limit: 100000, period: 60 },
        },
      },
      bindings: {
        WATCHLIST_ENABLED: 'true',
        FIREBASE_PROJECT_ID: project,
        FIREBASE_CLIENT_EMAIL: 'test@iris-test-project.iam.gserviceaccount.com',
        FIREBASE_PRIVATE_KEY: privateKey,
        PROVIDER_MODE: 'cache-only',
        CORS_ORIGINS: 'https://frontend.test',
      },
      /** Intercept outbound Worker traffic with controlled upstream responses.
       * @param request - Outbound request emitted by the isolated Worker.
       * @returns Controlled certificate, token-exchange or current-account evidence.
       */
      outboundService: async (request) => {
        const url = new URL(request.url);
        upstreamCalls.push(url.hostname);
        if (upstreamFailure)
          return new MFResponse('PRIVATE UPSTREAM ERROR', { status: 503 });
        if (url.hostname === 'www.googleapis.com')
          return MFResponse.json(
            { 'test-key': certificate },
            { headers: { 'cache-control': 'max-age=3600' } },
          );
        if (url.hostname === 'oauth2.googleapis.com') {
          const body = new URLSearchParams(await request.text());
          const assertion = body.get('assertion');
          assert.ok(assertion);
          const { payload } = await jwtVerify(assertion, publicKey, {
            algorithms: ['RS256'],
            audience: 'https://oauth2.googleapis.com/token',
            issuer: 'test@iris-test-project.iam.gserviceaccount.com',
          });
          assert.equal(
            payload.scope,
            'https://www.googleapis.com/auth/identitytoolkit',
          );
          return MFResponse.json({
            access_token: 'admin-test-token',
            token_type: 'Bearer',
            expires_in: 3600,
          });
        }
        assert.equal(
          url.href,
          `https://identitytoolkit.googleapis.com/v1/projects/${project}/accounts:lookup`,
        );
        assert.equal(
          request.headers.get('authorization'),
          'Bearer admin-test-token',
        );
        const body = await request.json();
        assert.ok(
          body &&
            typeof body === 'object' &&
            'localId' in body &&
            Array.isArray(body.localId),
        );
        const uid = String(body.localId[0]);
        lookups.push(uid);
        if (uid === 'racing' && observeRacingLookup) {
          const gate = new Promise<void>((resolve) => {
            releaseRacingLookup = resolve;
          });
          observeRacingLookup();
          await gate;
        }
        return MFResponse.json({
          users: user.absent ? [] : [{ localId: uid, ...user }],
        });
      },
    }),
  );
  try {
    const db = await mf.getD1Database('WATCHLIST_DB');
    const migration = await readFile(
      new URL('../../migrations/0001_watchlists.sql', import.meta.url),
      'utf8',
    );
    // exec accepts newline-separated statements; prepare keeps trigger bodies intact.
    const statements = migration
      .split(/;\s*(?:\r?\n){2}/)
      .map((sql) => sql.trim())
      .filter(Boolean);
    for (const sql of statements) await db.prepare(sql.replace(/;$/, '')).run();
    const alice = await token();
    const bob = await token('bob');
    /** Invoke the boundary under test with controlled request inputs.
     * @param path - Private or public route selected by the assertion.
     * @param method - HTTP method to exercise.
     * @param signed - Isolated signed account token.
     * @param headers - Additional controlled headers overriding fixture defaults.
     * @returns The actual isolated workerd response.
     */
    const call = (
      path = '/v3/me/watchlist',
      method = 'GET',
      signed = alice,
      headers: Record<string, string> = {},
    ) =>
      mf.dispatchFetch(`https://iris.test${path}`, {
        method,
        headers: {
          authorization: `Bearer ${signed}`,
          origin: 'https://frontend.test',
          ...headers,
        },
      });
    const asset = `/v3/me/watchlist/asset/${SOL_MINT}`;

    await t.test(
      'save, duplicate, cross-user reads/removals and no provider calls',
      async () => {
        const first = await call(asset, 'PUT');
        assert.equal(
          first.status,
          200,
          (await first.clone().text()) + JSON.stringify(upstreamCalls),
        );
        const body = record(await first.json());
        validate('WatchlistSaveEnvelope', body);
        assert.equal(first.headers.get('cache-control'), 'no-store');
        assert.equal(
          first.headers.get('access-control-allow-origin'),
          'https://frontend.test',
        );
        assert.deepEqual(
          record(await (await call(asset, 'PUT')).json()).data,
          body.data,
        );
        const bobList = await call('/v3/me/watchlist', 'GET', bob);
        const empty = record(await bobList.json());
        validate('WatchlistEnvelope', empty);
        assert.deepEqual(empty.data, { assets: [], wallets: [] });
        const removed = await call(asset, 'DELETE', bob);
        assert.equal(removed.status, 200);
        validate('WatchlistRemoveEnvelope', await removed.json());
        const items = record(record(await (await call()).json()).data).assets;
        assert.ok(Array.isArray(items));
        assert.equal(items.length, 1);
        assert.equal((await call('/v3/me/watchlist?uid=bob')).status, 400);
        assert.equal(
          (await call('/v3/me/watchlist/asset/invalid', 'PUT')).status,
          400,
        );
        assert.equal(
          (
            await mf.dispatchFetch(`https://iris.test${asset}`, {
              method: 'PUT',
              body: 'not empty',
              headers: { authorization: `Bearer ${alice}` },
            })
          ).status,
          400,
        );
        assert.equal((await call('/v3/assets', 'PUT')).status, 405);
        assert.equal(
          (await call('/v3/me/account', 'DELETE')).status,
          404,
          'WL-4 is not exposed',
        );
        const privateCors = await call('/v3/me/watchlist', 'OPTIONS');
        assert.match(
          privateCors.headers.get('access-control-allow-methods') ?? '',
          /PUT, DELETE/,
        );
        const publicCors = await call('/v3/assets', 'OPTIONS');
        assert.equal(
          publicCors.headers.get('access-control-allow-methods'),
          'GET, POST, OPTIONS',
        );
      },
    );
    await t.test(
      'every request checks current Firebase account state',
      async () => {
        const before = lookups.length;
        for (const [properties, status] of [
          [{ disabled: true }, 401],
          [{ absent: true }, 401],
          [{ validSince: String(now() + 10) }, 401],
          [{ emailVerified: false }, 403],
          [{ validSince: 'invalid' }, 503],
        ] as const) {
          user = { emailVerified: true, validSince: '0', ...properties };
          assert.equal((await call()).status, status);
        }
        assert.equal(lookups.length - before, 5);
        user = { emailVerified: true, validSince: '0' };
        upstreamFailure = true;
        const failed = await call();
        assert.equal(failed.status, 503);
        assert.doesNotMatch(
          await failed.text(),
          /PRIVATE UPSTREAM|admin-test-token|alice/,
        );
        assert.equal((await call('/health')).status, 200);
        upstreamFailure = false;
      },
    );
    await t.test(
      'D1 guards enforce capacity, immutable duplicates and deletion races',
      async () => {
        await db
          .prepare('DELETE FROM watchlist_items WHERE owner_uid = ?')
          .bind('alice')
          .run();
        await db.batch(
          Array.from({ length: 99 }, (_, i) =>
            db
              .prepare(
                'INSERT INTO watchlist_items(owner_uid, kind, address) VALUES (?, ?, ?)',
              )
              .bind('alice', 'asset', `fixture-${i}`),
          ),
        );
        const candidates = ['11111111111111111111111111111111', SOL_MINT];
        const statuses = await Promise.all(
          candidates.map(
            async (address) =>
              (await call(`/v3/me/watchlist/asset/${address}`, 'PUT')).status,
          ),
        );
        assert.deepEqual([...statuses].sort(), [200, 409]);
        const count = await db
          .prepare(
            "SELECT COUNT(*) AS n FROM watchlist_items WHERE owner_uid = 'alice' AND kind = 'asset'",
          )
          .first('n');
        assert.equal(count, 100);
        const existing = statuses[0] === 200 ? candidates[0] : candidates[1];
        assert.equal(
          (await call(`/v3/me/watchlist/asset/${existing}`, 'PUT')).status,
          200,
        );
        assert.equal(
          (await call(`/v3/me/watchlist/wallet/${SOL_MINT}`, 'PUT')).status,
          200,
        );
        await db.batch([
          db.prepare(
            "UPDATE watchlist_accounts SET state = 'deleting' WHERE uid = 'alice'",
          ),
          db.prepare("DELETE FROM watchlist_items WHERE owner_uid = 'alice'"),
        ]);
        for (const method of ['GET', 'PUT', 'DELETE'])
          assert.equal(
            (await call(method === 'GET' ? '/v3/me/watchlist' : asset, method))
              .status,
            403,
          );
        assert.equal(
          await db
            .prepare(
              "SELECT COUNT(*) AS n FROM watchlist_items WHERE owner_uid = 'alice'",
            )
            .first('n'),
          0,
        );
        await assert.rejects(
          db
            .prepare(
              "INSERT INTO watchlist_items(owner_uid, kind, address) VALUES ('alice', 'asset', 'bad')",
            )
            .run(),
          /ACCOUNT_DELETING/,
        );
      },
    );
    await t.test(
      'an in-flight save overlapping atomic deletion cannot recreate data',
      async () => {
        await db
          .prepare("INSERT INTO watchlist_accounts(uid) VALUES ('racing')")
          .run();
        const signed = await token('racing');
        const reachedLookup = new Promise<void>((resolve) => {
          observeRacingLookup = resolve;
        });
        const save = call(asset, 'PUT', signed);
        await reachedLookup;
        // The request is in flight. Race real D1 writes with the lifecycle transaction.
        const writes = Array.from({ length: 8 }, (_, i) =>
          db
            .prepare(
              'INSERT INTO watchlist_items(owner_uid, kind, address) VALUES (?, ?, ?)',
            )
            .bind('racing', 'asset', `racing-${i}`)
            .run(),
        );
        const deletion = db.batch([
          db.prepare(
            "UPDATE watchlist_accounts SET state = 'deleting' WHERE uid = 'racing'",
          ),
          db.prepare("DELETE FROM watchlist_items WHERE owner_uid = 'racing'"),
        ]);
        const outcomes = await Promise.allSettled(writes);
        await deletion;
        assert.ok(releaseRacingLookup);
        releaseRacingLookup();
        observeRacingLookup = undefined;
        assert.equal((await save).status, 403);
        for (const outcome of outcomes) {
          if (outcome.status === 'rejected')
            assert.match(String(outcome.reason), /ACCOUNT_DELETING/);
        }
        assert.equal(
          await db
            .prepare(
              "SELECT COUNT(*) AS n FROM watchlist_items WHERE owner_uid = 'racing'",
            )
            .first('n'),
          0,
        );
        assert.equal((await call(asset, 'PUT', signed)).status, 403);
      },
    );
    await t.test(
      'limiter denial and missing limiter cannot bypass authentication',
      async () => {
        const configuration = env();
        configuration.WATCHLIST_ENABLED = 'true';
        configuration.WATCHLIST_DB = db;
        delete configuration.WATCHLIST_RATE_LIMITER;
        const request = new Request('https://iris.test/v3/me/watchlist');
        assert.equal((await worker.fetch(request, configuration)).status, 503);
        configuration.WATCHLIST_RATE_LIMITER = {
          /** Deny the fixture request budget.
           * @returns A failed limiter decision that must stop private-route access.
           */
          limit: () => Promise.resolve({ success: false }),
        };
        const denied = await worker.fetch(request, configuration);
        assert.equal(denied.status, 429);
        assert.equal(denied.headers.get('retry-after'), '60');
      },
    );
  } finally {
    await mf.dispose();
  }
});

void test('missing private configuration and rate limits fail closed without breaking public endpoints', async () => {
  const configuration = env();
  const response = await worker.fetch(
    new Request('https://iris.test/v3/me/watchlist'),
    configuration,
  );
  assert.equal(response.status, 503);
  assert.equal(
    (await worker.fetch(new Request('https://iris.test/health'), configuration))
      .status,
    200,
  );
  assert.equal(
    (
      await worker.fetch(
        new Request('https://iris.test/v3/assets'),
        configuration,
      )
    ).status,
    200,
  );
});
