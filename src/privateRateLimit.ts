import type { Env } from './env.ts';
import { PrivateError } from './privateError.ts';

/** Approximate per-location protection; never a strict global quota. */
export async function privateRateLimit(env: Env, key: string) {
  if (!env.WATCHLIST_RATE_LIMITER)
    throw new PrivateError('WATCHLIST_UNAVAILABLE', 503);
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(key),
  );
  const digest = Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  const { success } = await env.WATCHLIST_RATE_LIMITER.limit({ key: digest });
  if (!success) throw new PrivateError('RATE_LIMITED', 429);
}
