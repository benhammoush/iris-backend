/**
 * Permanent-deletion boundaries against real local D1 and intercepted Firebase.
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
import { importPKCS8, SignJWT, decodeJwt, base64url } from 'jose';
import { privateKey, certificate } from '../support/watchlistKeys.ts';
import { record } from '../../src/record.ts';

const project = 'iris-test-project';
const key = await importPKCS8(privateKey, 'RS256');
const receiptKey = 'a'.repeat(43); // Public, test-only signing material.
/** Sign a controlled ID token, never a credential for a hosted Firebase project.
 * @param uid - Synthetic account identity.
 * @param age - Authentication age in seconds, independent of fresh issuance.
 * @returns Signed test token.
 */
async function token(uid = 'alice', age = 1) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ auth_time: now - age })
    .setSubject(uid)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .setAudience(project)
    .setIssuer(`https://securetoken.google.com/${project}`)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .sign(key);
}

void test('WL-4 durable deletion, scoped receipts, retries and orphan cleanup', async (t) => {
  const bundled = await build({
    stdin: {
      contents: `import worker from './src/index.ts'; import {CLEANUP_CRON} from './src/accountDeletion.ts'; export default { ...worker, async fetch(request, env) { if (new URL(request.url).pathname === '/test-cleanup') { try { await worker.scheduled({cron: CLEANUP_CRON},env); return new Response('ok'); } catch { return new Response('retry', {status:503}); } } return worker.fetch(request,env); }};`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
  });
  const absent = new Set<string>();
  const deleted: string[] = [];
  const lookedUp: string[] = [];
  let failure: 'none' | 'lookup' | 'permission' | 'timeout' | 'malformed' =
    'none';
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
        WATCHLIST_CLEANUP_ENABLED: 'true',
        WATCHLIST_RECEIPT_KEY: receiptKey,
        FIREBASE_PROJECT_ID: project,
        FIREBASE_CLIENT_EMAIL: 'test@iris-test-project.iam.gserviceaccount.com',
        FIREBASE_PRIVATE_KEY: privateKey,
        PROVIDER_MODE: 'cache-only',
        CORS_ORIGINS: 'https://frontend.test',
      },
      /** Intercept every upstream call; no real user, credential or provider mutation.
       * @param request - Bounded request emitted by workerd.
       * @returns Synthetic certificates, OAuth exchange and account-operation outcomes.
       */
      outboundService: async (request) => {
        const url = new URL(request.url);
        if (url.hostname === 'www.googleapis.com')
          return MFResponse.json(
            { 'test-key': certificate },
            { headers: { 'cache-control': 'max-age=3600' } },
          );
        if (url.hostname === 'oauth2.googleapis.com')
          return MFResponse.json({
            access_token: 'admin-test',
            token_type: 'Bearer',
            expires_in: 3600,
          });
        assert.equal(url.hostname, 'identitytoolkit.googleapis.com');
        assert.equal(request.headers.get('authorization'), 'Bearer admin-test');
        const body = record(await request.json());
        assert.equal(
          Object.hasOwn(body, 'idToken'),
          false,
          'cleanup never stores/reuses user tokens',
        );
        if (url.pathname.endsWith('accounts:lookup')) {
          assert.ok(Array.isArray(body.localId));
          const uid = String(body.localId[0]);
          lookedUp.push(uid);
          if (failure === 'lookup')
            return MFResponse.json(
              { error: { message: 'private error' } },
              { status: 503 },
            );
          if (failure === 'malformed')
            return MFResponse.json({ unexpected: true });
          return MFResponse.json(
            absent.has(uid)
              ? {}
              : {
                  users: [
                    { localId: uid, emailVerified: false, validSince: '0' },
                  ],
                },
          );
        }
        assert.ok(url.pathname.endsWith('accounts:delete'));
        assert.equal(typeof body.localId, 'string');
        if (failure === 'permission')
          return MFResponse.json(
            { error: { message: 'private permission details' } },
            { status: 403 },
          );
        const uid = String(body.localId);
        deleted.push(uid);
        absent.add(uid);
        if (failure === 'timeout')
          return MFResponse.json(
            { error: 'ambiguous failure after delete' },
            { status: 504 },
          );
        return MFResponse.json({});
      },
    }),
  );
  try {
    const db = await mf.getD1Database('WATCHLIST_DB');
    for (const name of ['0001_watchlists.sql', '0002_account_deletion.sql']) {
      const sql = await readFile(
        new URL(`../../migrations/${name}`, import.meta.url),
        'utf8',
      );
      for (const statement of sql
        .replace(/--[^\r\n]*/g, '')
        .split(/;\s*(?:\r?\n){2}/)
        .map((part) => part.trim())
        .filter(Boolean)) {
        // ALTER/INDEX statements are individually prepared; preserve the existing trigger body.
        if (name.startsWith('0002')) {
          for (const part of statement.split(';').filter((part) => part.trim()))
            await db.prepare(part).run();
        } else await db.prepare(statement.replace(/;$/, '')).run();
      }
    }
    /** Invoke an actual private route with controlled identity/receipt headers.
     * @param path - Private operation path.
     * @param method - HTTP operation.
     * @param credential - Signed test bearer or signed receipt header value.
     * @param confirmed - Whether explicit irreversible confirmation was supplied.
     * @returns The real workerd response.
     */
    const call = (
      path: string,
      method: string,
      credential: string,
      confirmed = true,
    ) =>
      mf.dispatchFetch(`https://iris.test${path}`, {
        method,
        headers: {
          authorization: credential,
          origin: 'https://frontend.test',
          ...(confirmed ? { 'x-iris-confirm-deletion': 'permanent' } : {}),
        },
      });
    /** Run one isolated scheduled-cleanup equivalent without opening a browser.
     * @returns The cleanup outcome; failed work remains durable.
     */
    const cleanup = () => mf.dispatchFetch('https://iris.test/test-cleanup');
    const alice = `Bearer ${await token()}`;
    await t.test(
      'confirmation, fresh auth and unverified deletion; atomic D1 failure cannot delete Firebase',
      async () => {
        assert.equal(
          (await call('/v3/me/account', 'DELETE', alice, false)).status,
          400,
        );
        assert.equal(
          (
            await call(
              '/v3/me/account',
              'DELETE',
              `Bearer ${await token('alice', 301)}`,
            )
          ).status,
          403,
        );
        await db
          .prepare(
            "CREATE TRIGGER fail_deletion BEFORE UPDATE OF state ON watchlist_accounts WHEN NEW.state = 'deleting' BEGIN SELECT RAISE(ABORT, 'test failure'); END",
          )
          .run();
        assert.equal(
          (await call('/v3/me/account', 'DELETE', alice)).status,
          503,
        );
        assert.equal(deleted.length, 0);
        assert.equal(
          await db
            .prepare("SELECT uid FROM watchlist_accounts WHERE uid = 'alice'")
            .first(),
          null,
        );
        await db.prepare('DROP TRIGGER fail_deletion').run();
      },
    );
    await db
      .prepare("INSERT INTO watchlist_accounts(uid) VALUES ('alice')")
      .run();
    await db
      .prepare(
        "INSERT INTO watchlist_items(owner_uid,kind,address) VALUES ('alice','asset','saved-reference')",
      )
      .run();
    const accepted = await call('/v3/me/account', 'DELETE', alice);
    assert.equal(accepted.status, 202, await accepted.clone().text());
    assert.equal(accepted.headers.get('cache-control'), 'no-store');
    const data = record(record(await accepted.json()).data);
    assert.equal(data.status, 'deleting');
    assert.equal(typeof data.receipt, 'string');
    const receipt = String(data.receipt);
    assert.equal(decodeJwt(receipt).sub, undefined, 'receipt exposes no UID');
    assert.equal(JSON.stringify(decodeJwt(receipt)).includes('alice'), false);
    assert.equal(
      await db
        .prepare(
          "SELECT address FROM watchlist_items WHERE owner_uid = 'alice'",
        )
        .first(),
      null,
    );
    await assert.rejects(
      db
        .prepare(
          "INSERT INTO watchlist_items(owner_uid,kind,address) VALUES ('alice','wallet','late-save')",
        )
        .run(),
      /ACCOUNT_DELETING/,
    );
    const again = record(
      record(await (await call('/v3/me/account', 'DELETE', alice)).json()).data,
    );
    assert.equal(
      again.receipt,
      receipt,
      'repeat cannot extend the receipt or change the lifecycle',
    );
    assert.equal(
      (await call('/v3/me/account/deletion', 'GET', alice)).status,
      401,
    );
    assert.equal(
      (await call('/v3/me/watchlist', 'GET', `Deletion ${receipt}`)).status,
      401,
    );
    assert.equal(
      (
        await call(
          '/v3/me/account/deletion',
          'GET',
          `Deletion ${receipt.slice(0, -4)}xxxx`,
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await call(
          '/v3/me/account/deletion?uid=bob',
          'GET',
          `Deletion ${receipt}`,
        )
      ).status,
      400,
    );
    assert.equal(
      (await call('/v3/me/account/deletion', 'GET', `Deletion ${receipt}`))
        .status,
      200,
    );
    await t.test(
      'receipt expiry, issuer, audience, purpose and signing-key constraints',
      async () => {
        const now = Math.floor(Date.now() / 1000);
        const claims = decodeJwt(receipt);
        for (const overrides of [
          { iat: now - 7200, exp: now - 3600 },
          { iss: 'other-project' },
          { aud: 'watchlist' },
          { exp: now + 7200 },
          { jti: 'another-lifecycle' },
        ]) {
          const forged = await new SignJWT({ ...claims, ...overrides })
            .setProtectedHeader({ alg: 'HS256', typ: 'iris-deletion+jwt' })
            .sign(base64url.decode(receiptKey));
          assert.equal(
            (await call('/v3/me/account/deletion', 'GET', `Deletion ${forged}`))
              .status,
            401,
          );
        }
        const wrongKey = await new SignJWT(claims)
          .setProtectedHeader({ alg: 'HS256', typ: 'iris-deletion+jwt' })
          .sign(new Uint8Array(32));
        assert.equal(
          (await call('/v3/me/account/deletion', 'GET', `Deletion ${wrongKey}`))
            .status,
          401,
        );
        const wrongType = await new SignJWT(claims)
          .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
          .sign(base64url.decode(receiptKey));
        assert.equal(
          (
            await call(
              '/v3/me/account/deletion',
              'GET',
              `Deletion ${wrongType}`,
            )
          ).status,
          401,
        );
        assert.equal(
          (await call('/v3/me/account', 'DELETE', `Deletion ${receipt}`, false))
            .status,
          200,
        );
      },
    );
    await t.test(
      'permission failure never completes; durable retry confirms absence after ambiguous timeout',
      async () => {
        failure = 'permission';
        assert.equal((await cleanup()).status, 503);
        let row = record(
          await db
            .prepare(
              "SELECT state, attempts, next_attempt_at FROM watchlist_accounts WHERE uid = 'alice'",
            )
            .first(),
        );
        assert.equal(row.state, 'deleting');
        assert.equal(row.attempts, 1);
        assert.ok(Number(row.next_attempt_at) > Date.now() / 1000);
        await cleanup();
        row = record(
          await db
            .prepare(
              "SELECT attempts FROM watchlist_accounts WHERE uid = 'alice'",
            )
            .first(),
        );
        assert.equal(
          row.attempts,
          1,
          'backoff prevents repeated provider work',
        );
        await db
          .prepare(
            "UPDATE watchlist_accounts SET next_attempt_at = 0 WHERE uid = 'alice'",
          )
          .run();
        failure = 'timeout';
        assert.equal((await cleanup()).status, 503);
        assert.equal(
          record(
            await db
              .prepare(
                "SELECT state FROM watchlist_accounts WHERE uid = 'alice'",
              )
              .first(),
          ).state,
          'deleting',
        );
        failure = 'none';
        await db
          .prepare(
            "UPDATE watchlist_accounts SET next_attempt_at = 0 WHERE uid = 'alice'",
          )
          .run();
        assert.equal((await cleanup()).status, 200);
        assert.deepEqual(
          record(
            record(
              await (
                await call(
                  '/v3/me/account/deletion',
                  'GET',
                  `Deletion ${receipt}`,
                )
              ).json(),
            ).data,
          ),
          { status: 'deleted' },
        );
        assert.deepEqual(deleted, ['alice']);
        assert.equal(
          (await call('/v3/me/account', 'DELETE', alice)).status,
          401,
          'old token cannot revive or delete another identity',
        );
      },
    );
    await t.test(
      'orphan checks preserve rows on outage/malformed replies and purge only confirmed absence',
      async () => {
        await db
          .prepare(
            "INSERT INTO watchlist_accounts(uid) VALUES ('orphan'), ('bob')",
          )
          .run();
        await db
          .prepare(
            "INSERT INTO watchlist_items(owner_uid,kind,address) VALUES ('orphan','asset','private-reference')",
          )
          .run();
        absent.add('orphan');
        for (const mode of ['lookup', 'malformed'] as const) {
          failure = mode;
          await db
            .prepare(
              "UPDATE watchlist_accounts SET checked_at = 0 WHERE state = 'active'",
            )
            .run();
          assert.equal((await cleanup()).status, 503);
          assert.ok(
            await db
              .prepare(
                "SELECT address FROM watchlist_items WHERE owner_uid = 'orphan'",
              )
              .first(),
          );
        }
        failure = 'none';
        await db
          .prepare(
            "UPDATE watchlist_accounts SET checked_at = 0 WHERE state = 'active'",
          )
          .run();
        await cleanup();
        assert.equal(
          await db
            .prepare(
              "SELECT address FROM watchlist_items WHERE owner_uid = 'orphan'",
            )
            .first(),
          null,
        );
        assert.equal(
          record(
            await db
              .prepare("SELECT state FROM watchlist_accounts WHERE uid = 'bob'")
              .first(),
          ).state,
          'active',
        );
        assert.equal(
          deleted.includes('orphan'),
          false,
          'orphan cleanup does not delete a newly created Firebase identity',
        );
      },
    );
    await t.test(
      'Firebase success with D1 completion failure remains retryable; markers persist for 31 days',
      async () => {
        await call(
          '/v3/me/account',
          'DELETE',
          `Bearer ${await token('completion-failure')}`,
        );
        await db
          .prepare(
            "CREATE TRIGGER fail_completion BEFORE UPDATE OF state ON watchlist_accounts WHEN NEW.state = 'deleted' AND NEW.uid = 'completion-failure' BEGIN SELECT RAISE(ABORT, 'test failure'); END",
          )
          .run();
        assert.equal((await cleanup()).status, 503);
        assert.ok(absent.has('completion-failure'));
        assert.equal(
          record(
            await db
              .prepare(
                "SELECT state FROM watchlist_accounts WHERE uid = 'completion-failure'",
              )
              .first(),
          ).state,
          'deleting',
        );
        await db.prepare('DROP TRIGGER fail_completion').run();
        await db
          .prepare(
            "UPDATE watchlist_accounts SET next_attempt_at = 0 WHERE uid = 'completion-failure'",
          )
          .run();
        await cleanup();
        assert.equal(
          deleted.filter((uid) => uid === 'completion-failure').length,
          1,
        );
        assert.ok(
          await db
            .prepare("SELECT uid FROM watchlist_accounts WHERE uid = 'alice'")
            .first(),
        );
        await db
          .prepare(
            "UPDATE watchlist_accounts SET completed_at = 1 WHERE uid = 'alice'",
          )
          .run();
        await cleanup();
        assert.equal(
          await db
            .prepare("SELECT uid FROM watchlist_accounts WHERE uid = 'alice'")
            .first(),
          null,
        );
        assert.equal(
          (await call('/v3/me/account/deletion', 'GET', `Deletion ${receipt}`))
            .status,
          401,
        );
      },
    );
    await t.test(
      'orphan passes are bounded and fair across invocations',
      async () => {
        for (let i = 0; i < 12; i++)
          await db
            .prepare('INSERT INTO watchlist_accounts(uid) VALUES (?)')
            .bind(`page-${i}`)
            .run();
        const before = lookedUp.length;
        await cleanup();
        assert.equal(lookedUp.length - before, 10);
        await cleanup();
        assert.equal(
          new Set(
            lookedUp.slice(before).filter((uid) => uid.startsWith('page-')),
          ).size,
          12,
        );
      },
    );
    assert.ok(lookedUp.includes('bob'));
  } finally {
    await mf.dispose();
  }
});
