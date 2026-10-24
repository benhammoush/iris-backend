/**
 * Allowlisted protocol identities used to recognize supported swaps.
 * @packageDocumentation
 */

// This intentionally small allow-list is for swaps through tracked pools only.
// It is not evidence of, or a scanner for, all activity on a Solana DEX.
import { isRecord } from './record.ts';

const DEX_ROUTES = [
  {
    protocol: 'Raydium AMM',
    source: 'RAYDIUM',
    programId: '675kPX9MHTjS2zt1qfr1NYHuzefQfuvLoV8fK5b1Mp8',
    pools: new Set(['58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2']),
  },
];

/** Match transaction instructions against the supported DEX registry. */
function routeFor(transaction: unknown) {
  if (!isRecord(transaction) || transaction.type !== 'SWAP') return null;
  const accountData: unknown[] = Array.isArray(transaction.accountData)
    ? transaction.accountData
    : [];
  return DEX_ROUTES.find(
    (route) =>
      transaction.source === route.source &&
      accountData.some(
        (account) =>
          isRecord(account) &&
          ((typeof account.account === 'string' &&
            route.pools.has(account.account)) ||
            account.account === route.programId),
      ),
  );
}

/** Accept swaps only when a supported registry route can identify them. */
export function isRegisteredDexSwap(transaction: unknown): boolean {
  return Boolean(routeFor(transaction));
}

/** Resolve the registered protocol identity for a decoded swap. */
export function protocolForSwap(transaction: unknown): string | null {
  return routeFor(transaction)?.protocol || null;
}

/** Expose the supported registry routes without inferring unregistered protocols. */
export function registeredDexRoutes() {
  return DEX_ROUTES.map(({ pools, ...route }) => ({
    ...route,
    pools: [...pools],
  }));
}
