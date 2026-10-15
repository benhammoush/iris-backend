// Only allowlisted labels and bounded scalar values cross the logging boundary.
// Never serialize errors, URLs, headers, payloads or single-flight keys.
const operations = new Set([
  'http-request',
  'scheduled-refresh',
  'authenticated-refresh',
  'snapshot-refresh',
  'dashboard-refresh',
  'recent-refresh',
  'defillama-refresh',
  'provider-read',
  'tracked-swaps',
  'network-refresh',
  'network-rpc',
  'market-refresh',
  'discovery-refresh',
  'wallet-enrichment',
  'candles',
  'asset-lookup',
  'wallet-lookup',
  'parsed-events',
]);
const providers = new Map([
  ['Jupiter', 'jupiter'],
  ['Birdeye', 'birdeye'],
  ['Helius', 'helius'],
  ['Helius RPC', 'helius'],
  ['Helius enhanced', 'helius'],
  ['Helius Parsed Events', 'helius'],
  ['Helius parsed events', 'helius'],
  ['DefiLlama', 'defillama'],
  ['DefiLlama DEX overview', 'defillama'],
  ['DefiLlama protocol', 'defillama'],
]);
const rpcMethods = new Set([
  'getSlot:processed',
  'getSlot:confirmed',
  'getSlot:finalized',
  'getBlockHeight',
  'getEpochInfo',
  'getRecentPerformanceSamples',
  'getRecentPrioritizationFees',
  'getVoteAccounts',
  'getSupply',
  'getInflationRate',
  'getInflationGovernor',
  'getBlocksWithLimit',
  'getBlockTime',
  'getBlockProduction',
  'getBlock',
]);
const failures = new Set(['http', 'network', 'timeout', 'json']);
type Outcome = 'completed' | 'failed' | 'retry' | 'fallback';
interface Diagnostic {
  event: 'request' | 'refresh' | 'provider' | 'operation';
  operation: string;
  outcome: Outcome;
  provider?: string;
  requestId?: string;
  operationId?: string;
  durationMs?: number;
  status?: number | null;
  attempt?: number;
  method?: string;
  cause?: unknown;
}

function correlation(value?: string) {
  return value &&
    /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16}(?:-[A-Z]{3})?)$/i.test(
      value,
    )
    ? value
    : null;
}

function failure(cause: unknown) {
  if (
    cause instanceof Error &&
    cause.name === 'ProviderRequestError' &&
    'kind' in cause
  ) {
    return typeof cause.kind === 'string' && failures.has(cause.kind)
      ? cause.kind
      : 'unknown';
  }
  return 'unknown';
}

export function diagnostic(input: Diagnostic): void {
  try {
    const fields = {
      schemaVersion: 1,
      event: ['request', 'refresh', 'provider', 'operation'].includes(
        input.event,
      )
        ? input.event
        : 'unknown',
      operation: operations.has(input.operation) ? input.operation : 'unknown',
      outcome: ['completed', 'failed', 'retry', 'fallback'].includes(
        input.outcome,
      )
        ? input.outcome
        : 'unknown',
      provider: providers.get(input.provider ?? '') ?? null,
      requestId: correlation(input.requestId),
      operationId: correlation(input.operationId),
      durationMs:
        typeof input.durationMs === 'number' &&
        Number.isFinite(input.durationMs)
          ? Math.max(0, Math.round(input.durationMs))
          : null,
      status:
        typeof input.status === 'number' &&
        Number.isInteger(input.status) &&
        input.status >= 100 &&
        input.status <= 599
          ? input.status
          : null,
      attempt:
        input.attempt === 1 || input.attempt === 2 ? input.attempt : null,
      method:
        rpcMethods.has(input.method ?? '') ||
        ['GET', 'POST', 'OPTIONS'].includes(input.method ?? '')
          ? input.method
          : null,
      failure: input.outcome === 'completed' ? null : failure(input.cause),
    };
    if (input.outcome === 'completed') console.info(fields);
    else console.warn(fields);
  } catch {
    // Logging must never change response, retry or cache/publication behavior.
  }
}

export function unavailable(
  operation: string,
  provider: string,
  cause?: unknown,
  requestId?: string,
  method?: string,
) {
  diagnostic({
    event: 'operation',
    operation,
    provider,
    outcome: 'fallback',
    cause,
    requestId,
    method,
  });
}

export async function refreshDiagnostic<T>(
  operation: string,
  work: () => Promise<T>,
  requestId?: string,
): Promise<T> {
  const started = Date.now();
  const operationId = crypto.randomUUID();
  try {
    const result = await work();
    diagnostic({
      event: 'refresh',
      operation,
      outcome: 'completed',
      operationId,
      requestId,
      durationMs: Date.now() - started,
    });
    return result;
  } catch (cause) {
    diagnostic({
      event: 'refresh',
      operation,
      outcome: 'failed',
      operationId,
      requestId,
      durationMs: Date.now() - started,
      cause,
    });
    throw cause;
  }
}
