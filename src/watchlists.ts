/**
 * Authenticated, account-isolated saved-asset and saved-wallet operations.
 * @packageDocumentation
 */

import type { Env } from './env.ts';
import { authenticateFirebase } from './firebaseAuth.ts';
import { error, json } from './http.ts';
import { PrivateError } from './privateError.ts';
import { isBase58PublicKey } from './transforms.ts';
import { privateRateLimit } from './privateRateLimit.ts';
import { accountDeletion } from './accountDeletion.ts';

/** Minimal request fields accepted by the private watchlist route. */
interface PrivateRequest {
  url: string;
  method: string;
  headers: Pick<Headers, 'get'>;
  body?: ReadableStream<Uint8Array> | null;
}

/** Handle authenticated watchlist operations without exposing private account data to public routes.
 * @param request - Private-route request with no supported body or query parameters.
 * @param env - Selected account database, limiter and Firebase configuration.
 * @param id - Request correlation identifier.
 * @param origin - Validated allowed browser origin, or null.
 * @returns An account-isolated watchlist response or a controlled private error.
 */
export async function watchlistRoute(
  request: PrivateRequest,
  env: Env,
  id: string,
  origin: string | null,
) {
  try {
    const url = new URL(request.url);
    const match = /^\/v3\/me\/watchlist\/(asset|wallet)\/([^/]+)$/.exec(
      url.pathname,
    );
    const list = url.pathname === '/v3/me/watchlist';
    const account = url.pathname === '/v3/me/account';
    const deletionStatus = url.pathname === '/v3/me/account/deletion';
    if (!list && !match && !account && !deletionStatus)
      throw new PrivateError('NOT_FOUND', 404);
    if (
      (list && request.method !== 'GET') ||
      (match && !['PUT', 'DELETE'].includes(request.method)) ||
      (account && request.method !== 'DELETE') ||
      (deletionStatus && request.method !== 'GET')
    )
      throw new PrivateError('METHOD_NOT_ALLOWED', 405);
    if (
      url.search ||
      (request.headers.get('content-length') !== null &&
        request.headers.get('content-length') !== '0')
    )
      throw new PrivateError('INVALID_WATCHLIST_ITEM', 400);
    if (request.body) {
      const reader = request.body.getReader();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new PrivateError('INVALID_WATCHLIST_ITEM', 400)),
              1000,
            );
          }),
        ]);
        if (!chunk.done) throw new PrivateError('INVALID_WATCHLIST_ITEM', 400);
      } finally {
        clearTimeout(timeout);
        await reader.cancel();
      }
    }
    if (
      env.WATCHLIST_ENABLED !== 'true' ||
      !env.WATCHLIST_DB ||
      !env.FIREBASE_CLIENT_EMAIL ||
      !env.FIREBASE_PRIVATE_KEY
    )
      throw new PrivateError('WATCHLIST_UNAVAILABLE', 503);
    const db = env.WATCHLIST_DB;
    // The platform overwrites this header on hosted ingress; missing IPs share a bucket.
    await privateRateLimit(
      env,
      `ip:${request.headers.get('cf-connecting-ip') ?? 'unknown'}`,
    );
    if (account || deletionStatus) {
      const result = await accountDeletion(request, env, deletionStatus);
      return json(
        { data: result.data, meta: { requestId: id } },
        result.status,
        id,
        origin,
      );
    }
    const uid = await authenticateFirebase(request, env);
    if (match && !isBase58PublicKey(match[2]))
      throw new PrivateError('INVALID_WATCHLIST_ITEM', 400);
    await db
      .prepare(
        'INSERT INTO watchlist_accounts(uid) VALUES (?) ON CONFLICT(uid) DO NOTHING',
      )
      .bind(uid)
      .run();
    /** Prepare the active-account lookup used in the same batch as private data access.
     * @returns The lookup statement bound to the verified account identity.
     */
    const active = () =>
      db
        .prepare(
          "SELECT state FROM watchlist_accounts WHERE uid = ? AND state = 'active'",
        )
        .bind(uid);
    /** Validate that the account remains active before accepting stored watchlist results.
     * @param rows - Active-account evidence returned in the same batch as private data access.
     */
    const checkActive = (rows: unknown[]) => {
      if (!rows.length) throw new PrivateError('ACCOUNT_DELETING', 403);
    };
    if (list) {
      const result = await db.batch<Record<string, unknown>>([
        active(),
        db
          .prepare(
            "SELECT kind, address, saved_at AS savedAt FROM watchlist_items WHERE owner_uid = ? AND EXISTS (SELECT 1 FROM watchlist_accounts WHERE uid = ? AND state = 'active') ORDER BY saved_at DESC, address ASC LIMIT 200",
          )
          .bind(uid, uid),
      ]);
      checkActive(result[0].results);
      const items = result[1].results;
      /** Project saved rows of the requested kind into the private response collection.
       * @param kind - Asset or wallet collection to project.
       * @returns Only saved addresses and timestamps belonging to that collection.
       */
      const section = (kind: string) =>
        items
          .filter((item) => item.kind === kind)
          .map((item) => ({ address: item.address, savedAt: item.savedAt }));
      return json(
        {
          data: { assets: section('asset'), wallets: section('wallet') },
          meta: { requestId: id },
        },
        200,
        id,
        origin,
      );
    }
    if (!match) throw new PrivateError('NOT_FOUND', 404);
    const [, kind, address] = match;
    if (request.method === 'PUT') {
      const result = await db.batch([
        db
          .prepare(
            'INSERT INTO watchlist_items(owner_uid, kind, address) VALUES (?, ?, ?) ON CONFLICT(owner_uid, kind, address) DO NOTHING',
          )
          .bind(uid, kind, address),
        db
          .prepare(
            'SELECT address, saved_at AS savedAt FROM watchlist_items WHERE owner_uid = ? AND kind = ? AND address = ?',
          )
          .bind(uid, kind, address),
      ]);
      const item = result[1].results[0];
      if (!item) throw new PrivateError('WATCHLIST_UNAVAILABLE', 503);
      return json(
        { data: { kind, ...item }, meta: { requestId: id } },
        200,
        id,
        origin,
      );
    }
    const result = await db.batch([
      active(),
      db
        .prepare(
          "DELETE FROM watchlist_items WHERE owner_uid = ? AND kind = ? AND address = ? AND EXISTS (SELECT 1 FROM watchlist_accounts WHERE uid = ? AND state = 'active')",
        )
        .bind(uid, kind, address, uid),
    ]);
    checkActive(result[0].results);
    return json(
      { data: { removed: true }, meta: { requestId: id } },
      200,
      id,
      origin,
    );
  } catch (cause) {
    let failure =
      cause instanceof PrivateError
        ? cause
        : new PrivateError('WATCHLIST_UNAVAILABLE', 503);
    // D1 wraps trigger messages. Match only our fixed markers; never return SQL/errors.
    if (
      cause instanceof Error &&
      /\bWATCHLIST_LIMIT_REACHED\b/.test(cause.message)
    )
      failure = new PrivateError('WATCHLIST_LIMIT_REACHED', 409);
    if (cause instanceof Error && /\bACCOUNT_DELETING\b/.test(cause.message))
      failure = new PrivateError('ACCOUNT_DELETING', 403);
    const response = error(
      failure.code,
      'The private watchlist request could not be completed.',
      failure.status,
      id,
      origin,
    );
    if (failure.status === 429) response.headers.set('retry-after', '60');
    return response;
  }
}
