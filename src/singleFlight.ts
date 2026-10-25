/**
 * Binding- and configuration-scoped sharing of equivalent in-flight work.
 * @packageDocumentation
 */

import type { Env } from './env.ts';
import type { ProviderConfig } from './config.ts';

/** Supported primitive component of a collision-safe shared-work key. */
type KeyPart = string | number | boolean | null | undefined | object;
const pending = new WeakMap<object, Map<string, Promise<unknown>>>();
const identities = new WeakMap<object, number>();
let nextIdentity = 0;

// Keys stay in isolate memory only. Object/function parts compare by identity;
// primitive parts are encoded without delimiter or null/undefined collisions.
/** Encode a key component without allowing adjacent values to collide.
 * @param part - Primitive or object identity component of the operation key.
 * @returns A type-tagged value or stable isolate-local object identity.
 */
function encode(part: KeyPart) {
  if (
    part !== null &&
    (typeof part === 'object' || typeof part === 'function')
  ) {
    let id = identities.get(part);
    if (id === undefined) {
      id = ++nextIdentity;
      identities.set(part, id);
    }
    return ['identity', id];
  }
  return [typeof part, part];
}

/** Share equivalent in-flight work only within the supplied scope; discard the entry after completion.
 * @param scope - Binding/configuration owner; absent scope disables sharing.
 * @param parts - Collision-safe operation and configuration identity components.
 * @param work - Operation whose promise and result type the key identifies at every call site.
 * @returns The matching pending operation, or a fresh operation with cleanup after settlement.
 */
export function singleFlight<T>(
  scope: object | null | undefined,
  parts: readonly KeyPart[],
  work: () => Promise<T>,
): Promise<T> {
  // Without a binding/scope there is no safe environment identity to share.
  if (!scope) return work();
  let flights = pending.get(scope);
  if (!flights) {
    flights = new Map();
    pending.set(scope, flights);
  }
  const key = JSON.stringify(parts.map(encode));
  const existing = flights.get(key);
  // A key identifies one operation and its result type at every call site.
  if (existing) return existing as Promise<T>;
  const entries = flights;
  const result = Promise.resolve()
    .then(work)
    .finally(() => {
      entries.delete(key);
    });
  entries.set(key, result);
  return result;
}

/** Include effective provider configuration in shared-work identity to prevent cross-configuration reuse.
 * @param env - Environment fallback credentials; key material stays in isolate memory.
 * @param config - Effective selected provider credentials and mode.
 * @returns Configuration identity components preventing cross-provider reuse.
 */
export function providerKey(env: Env, config: ProviderConfig) {
  return [
    config.heliusApiKey || env.HELIUS_API_KEY,
    config.jupiterApiKey || env.JUPITER_API_KEY,
    config.birdeyeApiKey || env.BIRDEYE_API_KEY,
    config.providerMode ?? 'live',
  ];
}
