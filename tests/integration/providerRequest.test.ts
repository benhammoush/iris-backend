/**
 * Regression coverage and controlled fixtures for provider request.
 * @packageDocumentation
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  providerJson,
  ProviderRequestError,
} from '../../src/providerRequest.ts';
import { heliusRpc } from '../../src/v3.ts';

const url = 'https://provider.test/read?api-key=never-print-this';
const options = { provider: 'Test provider' };

void test('exhausted or invalid attempt budgets fail before fetching', async (t) => {
  const fetcher = t.mock.method(globalThis, 'fetch', () =>
    Promise.resolve(Response.json({})),
  );
  for (const remaining of [0, -1, 0.5, NaN, Infinity]) {
    await assert.rejects(
      providerJson(url, {}, { ...options, budget: { remaining } }),
      classified('budget'),
    );
  }
  assert.equal(fetcher.mock.callCount(), 0);
});

void test('retries consume the same allowance and cannot exceed it', async (t) => {
  const fetcher = t.mock.method(globalThis, 'fetch', () =>
    Promise.resolve(new Response(null, { status: 503 })),
  );
  const budget = { remaining: 1 };
  await assert.rejects(
    providerJson(url, {}, { ...options, budget }),
    classified('budget'),
  );
  assert.equal(fetcher.mock.callCount(), 1);
  assert.equal(budget.remaining, 0);
});

void test('concurrent reads reserve each attempt before dispatch and budgets are request-owned', async (t) => {
  const fetcher = t.mock.method(globalThis, 'fetch', () =>
    Promise.resolve(Response.json({ ok: true })),
  );
  const budget = { remaining: 2 };
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () =>
      providerJson(url, {}, { ...options, budget }),
    ),
  );
  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    2,
  );
  assert.equal(fetcher.mock.callCount(), 2);
  assert.equal(budget.remaining, 0);
  await providerJson(url, {}, { ...options, budget: { remaining: 1 } });
  assert.equal(fetcher.mock.callCount(), 3);
});

/** Flush queued promise callbacks without introducing real timing delays.
 * @returns Completion after bounded promise-queue draining under the controlled clock.
 */
async function drainMicrotasks() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

void test('valid Retry-After seconds and dates are respected when they fit', async (t) => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  t.mock.method(Math, 'random', () => 0);
  for (const retryAfter of ['1', new Date(Date.now() + 1000).toUTCString()]) {
    let calls = 0;
    const fetcher = t.mock.method(globalThis, 'fetch', () => {
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? new Response(null, {
              status: 429,
              headers: { 'retry-after': retryAfter },
            })
          : Response.json({ ok: true }),
      );
    });
    const pending = providerJson(url, {}, options);
    await drainMicrotasks();
    t.mock.timers.tick(999);
    await drainMicrotasks();
    assert.equal(calls, 1);
    t.mock.timers.tick(1);
    assert.deepEqual(await pending, { ok: true });
    assert.equal(calls, 2);
    fetcher.mock.restore();
    t.mock.timers.setTime(now);
  }
});

void test('both attempts and delay share one deadline', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  t.mock.method(Math, 'random', () => 0);
  let calls = 0;
  let signal: AbortSignal | null | undefined;
  t.mock.method(
    globalThis,
    'fetch',
    async (_input: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal;
      calls += 1;
      return new Promise<Response>((resolve) => {
        if (calls === 1)
          setTimeout(() => resolve(new Response(null, { status: 503 })), 600);
      });
    },
  );
  const pending = providerJson(url, {}, { ...options, timeoutMs: 1000 });
  const rejected = assert.rejects(pending, classified('timeout'));
  t.mock.timers.tick(600);
  await drainMicrotasks();
  assert.equal(calls, 1);
  t.mock.timers.tick(250);
  await drainMicrotasks();
  assert.equal(calls, 2);
  t.mock.timers.tick(150);
  await rejected;
  assert.equal(signal?.aborted, true);
  t.mock.timers.tick(10_000);
  assert.equal(calls, 2);
});

/** Capture the classified provider failure produced by the fixture.
 * @param kind - Expected controlled provider-failure category.
 * @param status - Expected optional HTTP failure status.
 * @returns An assertion predicate that also rejects credential-bearing error text.
 */
function classified(kind: string, status: number | null = null) {
  return (error: unknown) => {
    assert.ok(error instanceof ProviderRequestError);
    assert.equal(error.kind, kind);
    assert.equal(error.status, status);
    assert.equal(error.message.includes('never-print-this'), false);
    return true;
  };
}

void test('successful JSON preserves atomic strings and nullable values', async (t) => {
  const payload = { amount: '900719925474099312345', price: null };
  const fetcher = t.mock.method(globalThis, 'fetch', () =>
    Promise.resolve(Response.json(payload)),
  );
  assert.deepEqual(await providerJson(url, {}, options), payload);
  assert.equal(fetcher.mock.callCount(), 1);
});

for (const status of [429, 502, 503, 504]) {
  void test(`HTTP ${status} retries once with the same read and releases its body`, async (t) => {
    const failed = new Response('Unavailable', { status });
    let calls = 0;
    t.mock.method(
      globalThis,
      'fetch',
      (input: string | URL | Request, init?: RequestInit) => {
        assert.equal(input, url);
        assert.equal(init?.body, '{"method":"getSupply"}');
        assert.equal(init?.method, 'POST');
        assert.equal(
          new Headers(init?.headers).get('content-type'),
          'application/json',
        );
        calls += 1;
        return Promise.resolve(
          calls === 1 ? failed : Response.json({ result: 'ok' }),
        );
      },
    );
    assert.deepEqual(
      await providerJson(
        url,
        {
          method: 'POST',
          body: '{"method":"getSupply"}',
          headers: { 'content-type': 'application/json' },
        },
        { ...options, readOnlyPost: true },
      ),
      { result: 'ok' },
    );
    assert.equal(calls, 2);
    assert.equal(failed.body?.locked, false);
    assert.equal(failed.bodyUsed, true);
  });
}

void test('transport TypeErrors retry once; exhausted network errors are sanitized', async (t) => {
  const fetcher = t.mock.method(globalThis, 'fetch', () => {
    return Promise.reject(new TypeError(`Cannot reach ${url}`));
  });
  await assert.rejects(providerJson(url, {}, options), classified('network'));
  assert.equal(fetcher.mock.callCount(), 2);
});

void test('a second transient HTTP failure stops at two attempts', async (t) => {
  const fetcher = t.mock.method(globalThis, 'fetch', () =>
    Promise.resolve(new Response('Unavailable', { status: 503 })),
  );
  await assert.rejects(providerJson(url, {}, options), classified('http', 503));
  assert.equal(fetcher.mock.callCount(), 2);
});

void test('permanent HTTP errors, malformed JSON and non-transport failures never retry', async (t) => {
  for (const status of [400, 401, 403, 404, 500]) {
    const fetcher = t.mock.method(globalThis, 'fetch', () =>
      Promise.resolve(new Response('private provider payload', { status })),
    );
    await assert.rejects(
      providerJson(url, {}, options),
      classified('http', status),
    );
    assert.equal(fetcher.mock.callCount(), 1);
    fetcher.mock.restore();
  }
  const malformed = t.mock.method(globalThis, 'fetch', () =>
    Promise.resolve(new Response('{broken')),
  );
  await assert.rejects(providerJson(url, {}, options), classified('json'));
  assert.equal(malformed.mock.callCount(), 1);
  malformed.mock.restore();
  const unexpected = t.mock.method(globalThis, 'fetch', () => {
    return Promise.reject(new Error(url));
  });
  await assert.rejects(providerJson(url, {}, options), classified('network'));
  assert.equal(unexpected.mock.callCount(), 1);
});

void test('Retry-After seconds and HTTP dates beyond the budget skip retries', async (t) => {
  for (const value of ['60', new Date(Date.now() + 60_000).toUTCString()]) {
    const fetcher = t.mock.method(globalThis, 'fetch', () =>
      Promise.resolve(
        new Response('Rate limited', {
          status: 429,
          headers: { 'retry-after': value },
        }),
      ),
    );
    await assert.rejects(
      providerJson(url, {}, options),
      classified('http', 429),
    );
    assert.equal(fetcher.mock.callCount(), 1);
    fetcher.mock.restore();
  }
});

void test('invalid Retry-After falls back to bounded jitter', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', () => {
    calls += 1;
    return Promise.resolve(
      calls === 1
        ? new Response('Unavailable', {
            status: 503,
            headers: { 'retry-after': 'invalid' },
          })
        : Response.json(null),
    );
  });
  assert.equal(await providerJson(url, {}, options), null);
  assert.equal(calls, 2);
});

void test('deadline includes pending fetch and body parsing even when a transport ignores abort', async (t) => {
  for (const pendingBody of [false, true]) {
    let signal: AbortSignal | null | undefined;
    const fetcher = t.mock.method(
      globalThis,
      'fetch',
      async (_input: string | URL | Request, init?: RequestInit) => {
        signal = init?.signal;
        if (pendingBody)
          return new Response(
            new ReadableStream({
              /** Drive the controlled stream fixture used by this response-boundary test. */
              start() {},
            }),
          );
        return new Promise<Response>(() => {});
      },
    );
    await assert.rejects(
      providerJson(url, {}, { ...options, timeoutMs: 20 }),
      classified('timeout'),
    );
    assert.equal(signal?.aborted, true);
    assert.equal(fetcher.mock.callCount(), 1);
    fetcher.mock.restore();
  }
});

void test('retry delay cannot extend a nearly exhausted deadline', async (t) => {
  // The HTTP response precedes the deadline; runner contention must not advance this clock.
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const fetcher = t.mock.method(globalThis, 'fetch', () =>
    Promise.resolve(new Response(null, { status: 503 })),
  );
  await assert.rejects(
    providerJson(url, {}, { ...options, timeoutMs: 20 }),
    classified('http', 503),
  );
  assert.equal(fetcher.mock.callCount(), 1);
});

void test('mutation methods and non-replayable bodies are rejected before fetch', async (t) => {
  const fetcher = t.mock.method(globalThis, 'fetch', () =>
    Promise.resolve(Response.json({})),
  );
  for (const init of [
    { method: 'POST' },
    { method: 'DELETE' },
    { method: 'PUT' },
    { body: new URLSearchParams() },
  ]) {
    await assert.rejects(
      providerJson(url, init, options),
      /Invalid provider read configuration/,
    );
  }
  assert.equal(fetcher.mock.callCount(), 0);
});

void test('Helius RPC application errors are not retried', async (t) => {
  const fetcher = t.mock.method(globalThis, 'fetch', () =>
    Promise.resolve(Response.json({ error: { message: 'Invalid request' } })),
  );
  await assert.rejects(
    heliusRpc('getSupply', [], 'test-key', 20_000),
    classified('json'),
  );
  assert.equal(fetcher.mock.callCount(), 1);
});

void test('Helius RPC forwards its timeout override', async (t) => {
  const fetcher = t.mock.method(
    globalThis,
    'fetch',
    async () => new Promise<Response>(() => {}),
  );
  await assert.rejects(
    heliusRpc('getSupply', [], 'test-key', 20),
    classified('timeout'),
  );
  assert.equal(fetcher.mock.callCount(), 1);
});
