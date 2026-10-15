import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  diagnostic,
  refreshDiagnostic,
  unavailable,
} from '../src/diagnostics.ts';
import { providerJson, ProviderRequestError } from '../src/providerRequest.ts';
import worker from '../src/index.ts';
import { refreshSnapshot } from '../src/snapshot.ts';
import { refreshHeliusDashboardSample } from '../src/recentTransactions.ts';
import { record } from '../src/record.ts';
import { readdirSync, readFileSync } from 'node:fs';
import { SOL_MINT, SNAPSHOT_POINTER_KEY } from '../src/constants.ts';

const secret = 'SECRET_NEVER_LOG';
const privateUrl = `https://provider.test/${secret}?api-key=${secret}`;
const id = '12345678-1234-1234-1234-123456789abc';
const env = () => ({
  SNAPSHOTS: { get: async () => null, put: async () => {} },
  PROVIDER_MODE: 'cache-only',
});
function capture(t: TestContext) {
  const logs: Record<string, unknown>[] = [];
  t.mock.method(console, 'info', (value: unknown) => logs.push(record(value)));
  t.mock.method(console, 'warn', (value: unknown) => logs.push(record(value)));
  t.mock.method(console, 'error', (value: unknown) => logs.push(record(value)));
  return logs;
}
async function drain() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

test('diagnostics serialize only stable allowlisted fields, never arbitrary context', (t) => {
  const logs = capture(t);
  const input = {
    event: 'operation' as const,
    operation: 'wallet-lookup',
    outcome: 'fallback' as const,
    provider: 'Helius',
    requestId: id,
    operationId: id,
    durationMs: 12.7,
    status: 503,
    method: 'getBlock',
    attempt: 1,
    cause: new Error(`${privateUrl} Authorization: Bearer ${secret}`),
    url: privateUrl,
    headers: { authorization: secret, 'x-api-key': secret },
    mint: secret,
    address: secret,
    payload: { data: secret },
  };
  diagnostic(input);
  assert.deepEqual(logs, [
    {
      schemaVersion: 1,
      event: 'operation',
      operation: 'wallet-lookup',
      outcome: 'fallback',
      provider: 'helius',
      requestId: id,
      operationId: id,
      durationMs: 13,
      status: 503,
      attempt: 1,
      method: 'getBlock',
      failure: 'unknown',
    },
  ]);
  assert.equal(JSON.stringify(logs).includes(secret), false);
});

test('untrusted labels, IDs and invalid scalar fields fail closed', (t) => {
  const logs = capture(t);
  diagnostic({
    event: 'provider',
    operation: privateUrl,
    provider: privateUrl,
    outcome: 'failed',
    requestId: secret,
    operationId: secret,
    method: secret,
    status: 999,
    attempt: 99,
    durationMs: Infinity,
    cause: new ProviderRequestError(secret, 'http', 999),
  });
  assert.deepEqual(logs[0], {
    schemaVersion: 1,
    event: 'provider',
    operation: 'unknown',
    outcome: 'failed',
    provider: null,
    requestId: null,
    operationId: null,
    durationMs: null,
    status: null,
    attempt: null,
    method: null,
    failure: 'http',
  });
  diagnostic({
    event: 'request',
    operation: 'http-request',
    outcome: 'completed',
    requestId: '0123456789abcdef-CDG',
    durationMs: -20,
  });
  assert.equal(logs[1].requestId, '0123456789abcdef-CDG');
  assert.equal(logs[1].durationMs, 0);
  assert.equal(JSON.stringify(logs).includes(secret), false);
});

test('diagnostic sink and hostile error getters cannot alter work or failures', async (t) => {
  t.mock.method(console, 'info', () => {
    throw new Error(secret);
  });
  t.mock.method(console, 'warn', () => {
    throw new Error(secret);
  });
  const cause = new Error(secret);
  Object.defineProperty(cause, 'name', {
    get: () => {
      throw new Error(secret);
    },
  });
  unavailable('network-rpc', 'Helius', cause);
  const result = { amount: '900719925474099312345', price: null };
  assert.equal(
    await refreshDiagnostic('snapshot-refresh', async () => result),
    result,
  );
  await assert.rejects(
    refreshDiagnostic('snapshot-refresh', async () => {
      throw cause;
    }),
    (error: unknown) => error === cause,
  );
  t.mock.method(globalThis, 'fetch', async () => Response.json(result));
  assert.deepEqual(
    await providerJson(privateUrl, {}, { provider: 'Jupiter' }),
    result,
  );
  const response = await worker.fetch(
    new Request('https://iris.test/health'),
    env(),
  );
  assert.equal(response.status, 200);
});

test('successful provider reads emit no per-call logs or payloads', async (t) => {
  const logs = capture(t);
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ data: secret }),
  );
  assert.deepEqual(
    await providerJson(
      privateUrl,
      { headers: { Authorization: `Bearer ${secret}` } },
      { provider: 'Jupiter' },
    ),
    { data: secret },
  );
  assert.deepEqual(logs, []);
});

test('retry and final failure share operation ID with bounded attempts and durations', async (t) => {
  const logs = capture(t);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  t.mock.method(Math, 'random', () => 0);
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(secret, { status: 503 }),
  );
  const pending = providerJson(
    privateUrl,
    { headers: { Authorization: `Bearer ${secret}` } },
    { provider: 'Jupiter' },
  );
  const rejected = assert.rejects(pending, {
    name: 'ProviderRequestError',
    kind: 'http',
    status: 503,
  });
  await drain();
  t.mock.timers.tick(250);
  await rejected;
  assert.deepEqual(
    logs.map((log) => [
      log.outcome,
      log.attempt,
      log.status,
      log.durationMs,
      log.failure,
    ]),
    [
      ['retry', 1, 503, 0, 'http'],
      ['failed', 2, 503, 250, 'http'],
    ],
  );
  assert.equal(logs[0].provider, 'jupiter');
  assert.equal(typeof logs[0].operationId, 'string');
  assert.equal(logs[0].operationId, logs[1].operationId);
  assert.equal(JSON.stringify(logs).includes(secret), false);
});

test('retry followed by success logs only the retry', async (t) => {
  const logs = capture(t);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  t.mock.method(Math, 'random', () => 0);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () =>
    ++calls === 1
      ? new Response(secret, { status: 429 })
      : Response.json({ amount: '1' }),
  );
  const pending = providerJson(privateUrl, {}, { provider: 'Birdeye' });
  await drain();
  t.mock.timers.tick(250);
  assert.deepEqual(await pending, { amount: '1' });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].outcome, 'retry');
});

test('JSON, transport and timeout diagnostics discard sensitive causes and bodies', async (t) => {
  const logs = capture(t);
  const fetcher = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(secret),
  );
  await assert.rejects(
    providerJson(privateUrl, {}, { provider: 'Helius RPC' }),
    { kind: 'json' },
  );
  fetcher.mock.restore();
  const transport = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error(privateUrl);
  });
  await assert.rejects(
    providerJson(privateUrl, {}, { provider: 'Helius RPC' }),
    { kind: 'network' },
  );
  transport.mock.restore();
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Promise<Response>(() => {}),
  );
  const pending = providerJson(
    privateUrl,
    {},
    { provider: 'Helius RPC', timeoutMs: 10 },
  );
  const rejected = assert.rejects(pending, { kind: 'timeout' });
  t.mock.timers.tick(10);
  await rejected;
  assert.deepEqual(
    logs.map((log) => log.failure),
    ['json', 'network', 'timeout'],
  );
  assert.equal(JSON.stringify(logs).includes(secret), false);
});

test('request summaries cover success, preflight, authorization and method denial without URLs/headers', async (t) => {
  const logs = capture(t);
  const testEnv = {
    ...env(),
    CORS_ORIGINS: 'https://allowed.test',
    REFRESH_TOKEN: secret,
  };
  const requests = [
    new Request(`https://iris.test/health?key=${secret}`, {
      headers: { 'cf-ray': id, Authorization: secret },
    }),
    new Request('https://iris.test/health', {
      method: 'OPTIONS',
      headers: { Origin: 'https://allowed.test' },
    }),
    new Request(`https://iris.test/internal/refresh?key=${secret}`, {
      method: 'POST',
      headers: { Authorization: 'wrong', 'cf-ray': secret },
    }),
    new Request('https://iris.test/health', { method: 'DELETE' }),
    new Request('https://iris.test/health', {
      headers: { Origin: `https://${secret}.test` },
    }),
  ];
  const statuses = [200, 204, 401, 405, 403];
  for (const [index, request] of requests.entries()) {
    const response = await worker.fetch(request, testEnv);
    assert.equal(response.status, statuses[index]);
    assert.equal(logs[index].status, statuses[index]);
    assert.equal(logs[index].event, 'request');
    assert.equal(typeof logs[index].durationMs, 'number');
    if (index === 0)
      assert.equal(logs[index].requestId, response.headers.get('x-request-id'));
  }
  assert.equal(logs[2].requestId, null);
  assert.equal(logs[3].method, null);
  assert.equal(JSON.stringify(logs).includes(secret), false);
});

test('route exceptions preserve public envelopes while logs omit cache errors', async (t) => {
  const logs = capture(t);
  const response = await worker.fetch(
    new Request(`https://iris.test/v3/assets?key=${secret}`, {
      headers: { 'cf-ray': id },
    }),
    {
      ...env(),
      SNAPSHOTS: {
        get: async () => {
          throw new Error(privateUrl);
        },
        put: async () => {},
      },
    },
  );
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: {
      code: 'INTERNAL_ERROR',
      message: 'The request could not be completed.',
      requestId: id,
    },
  });
  assert.equal(logs.at(-1)?.outcome, 'failed');
  assert.equal(logs.at(-1)?.requestId, id);
  assert.equal(JSON.stringify(logs).includes(secret), false);
});

test('coalesced refreshes emit one actual-operation summary without altering cache writes', async (t) => {
  const logs = capture(t);
  const testEnv = env();
  const write = t.mock.method(testEnv.SNAPSHOTS, 'put');
  const first = refreshSnapshot(testEnv, {});
  const second = refreshSnapshot(testEnv, {});
  assert.equal(first, second);
  const result = await first;
  assert.equal(result.source, 'fixture');
  assert.equal(write.mock.callCount(), 0);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].operation, 'snapshot-refresh');
  assert.equal(logs[0].outcome, 'completed');
  assert.equal(logs[0].requestId, null);
});

test('refresh failures retain the original rejection and safe completion fields', async (t) => {
  const logs = capture(t);
  await assert.rejects(
    refreshHeliusDashboardSample(env(), {}),
    /Helius is not configured/,
  );
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, 'refresh');
  assert.equal(logs[0].operation, 'dashboard-refresh');
  assert.equal(logs[0].outcome, 'failed');
  assert.equal(logs[0].failure, 'unknown');
  assert.equal(typeof logs[0].operationId, 'string');
});

test('authenticated refresh summaries correlate with request completion even with optional-source failures', async (t) => {
  const logs = capture(t);
  t.mock.method(globalThis, 'fetch', async () => Response.json([]));
  const response = await worker.fetch(
    new Request(`https://iris.test/internal/refresh?key=${secret}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'cf-ray': id },
    }),
    { ...env(), REFRESH_TOKEN: secret },
  );
  assert.equal(response.status, 200);
  const summary = logs.find(
    (log) =>
      log.event === 'refresh' && log.operation === 'authenticated-refresh',
  );
  assert.equal(summary?.requestId, id);
  assert.equal(summary?.outcome, 'completed');
  assert.ok(
    logs.some(
      (log) =>
        log.operation === 'dashboard-refresh' && log.outcome === 'failed',
    ),
  );
  assert.equal(logs.at(-1)?.requestId, id);
  assert.equal(JSON.stringify(logs).includes(secret), false);
});

test('authenticated and scheduled refresh failures preserve envelope/rejection and emit timed summaries', async (t) => {
  const logs = capture(t);
  t.mock.method(globalThis, 'fetch', async () => Response.json([]));
  const cause = new Error(privateUrl);
  const testEnv = {
    ...env(),
    REFRESH_TOKEN: secret,
    SNAPSHOTS: {
      get: async () => {
        throw cause;
      },
      put: async () => {},
    },
  };
  const response = await worker.fetch(
    new Request('https://iris.test/internal/refresh', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'cf-ray': id },
    }),
    testEnv,
  );
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: {
      code: 'REFRESH_FAILED',
      message: 'The snapshot refresh could not be completed.',
      requestId: id,
    },
  });
  await assert.rejects(
    worker.scheduled(null, testEnv),
    (error: unknown) => error === cause,
  );
  const summaries = logs.filter(
    (log) =>
      log.event === 'refresh' &&
      ['authenticated-refresh', 'scheduled-refresh'].includes(
        String(log.operation),
      ),
  );
  assert.equal(summaries.length, 2);
  assert.ok(
    summaries.every(
      (log) => log.outcome === 'failed' && typeof log.durationMs === 'number',
    ),
  );
  assert.equal(summaries[0].requestId, id);
  assert.equal(summaries[1].requestId, null);
  assert.equal(JSON.stringify(logs).includes(secret), false);
});

test('application console logging stays behind the safe diagnostics boundary', () => {
  const source = new URL('../src/', import.meta.url);
  for (const file of readdirSync(source).filter(
    (name) => name.endsWith('.ts') && name !== 'diagnostics.ts',
  )) {
    assert.doesNotMatch(
      readFileSync(new URL(file, source), 'utf8'),
      /console\s*(?:\.|\[)/,
      file,
    );
  }
});

test('throwing diagnostic sinks cannot interrupt retries or snapshot-before-pointer publication', async (t) => {
  t.mock.method(console, 'info', () => {
    throw new Error(secret);
  });
  t.mock.method(console, 'warn', () => {
    throw new Error(secret);
  });
  t.mock.timers.enable({
    apis: ['Date', 'setTimeout'],
    now: Date.parse('2026-10-13T12:00:00Z'),
  });
  t.mock.method(Math, 'random', () => 0);
  const retryFetch = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(secret, { status: 503 }),
  );
  const pending = providerJson(privateUrl, {}, { provider: 'Jupiter' });
  const rejected = assert.rejects(pending, { kind: 'http', status: 503 });
  await drain();
  t.mock.timers.tick(250);
  await rejected;
  assert.equal(retryFetch.mock.callCount(), 2);
  retryFetch.mock.restore();
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('helius-rpc')) return Response.json({ result: 123 });
    if (url.includes('/toptraded/'))
      return Response.json([
        {
          id: SOL_MINT,
          symbol: 'SOL',
          name: 'Solana',
          decimals: 9,
          isVerified: true,
        },
      ]);
    return Response.json([]);
  });
  const writes: { key: string; value: string }[] = [];
  const testEnv = {
    ...env(),
    HELIUS_API_KEY: secret,
    JUPITER_API_KEY: secret,
    SNAPSHOTS: {
      get: async () => null,
      put: async (key: string, value: string) => {
        writes.push({ key, value });
      },
    },
  };
  const snapshot = await refreshSnapshot(testEnv, {});
  assert.equal(snapshot.source, 'helius-jupiter');
  assert.equal(writes.length, 2);
  assert.match(writes[0].key, /^snapshot:v2:/);
  assert.equal(writes[1].key, SNAPSHOT_POINTER_KEY);
  assert.equal(record(JSON.parse(writes[1].value)).key, writes[0].key);
});
