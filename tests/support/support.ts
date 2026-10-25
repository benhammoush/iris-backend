/**
 * Regression coverage and controlled fixtures for support.
 * @packageDocumentation
 */

import type { Env, SnapshotStore } from '../../src/env.ts';

/** Response shape asserted by a fixture test; runtime schema validation lives in contract tests. */
export interface ResourceEnvelope<Data, Meta = Record<string, unknown>> {
  data: Data;
  meta: Meta;
}

/** Controlled public error fields asserted by response-boundary tests. */
export interface ErrorEnvelope {
  error: { code: string; message: string; requestId: string };
}

/** Read a statically expected fixture response without claiming runtime schema validation.
 * @param response - Actual response from the Worker under test.
 * @returns Parsed JSON with the assertion shape chosen by the test; contract tests validate schemas.
 */
export async function responseJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** Fetch input shape accepted by the isolated provider test adapter. */
export interface FetchStubOptions extends Omit<RequestInit, 'body'> {
  body: string;
}

/** Minimal provider-response capabilities exposed by the test adapter. */
interface FetchStubResponse {
  ok: boolean;
  status?: number;
  /** Return the controlled JSON payload for this provider-response fixture.
   * @returns Unknown fixture JSON consumed through a real Response boundary.
   */
  json?: () => Promise<unknown>;
  /** Return the controlled text body for this provider-response fixture.
   * @returns Fixture response text.
   */
  text?: () => Promise<string>;
}

/** Controlled provider reply, synchronous or deferred for explicit completion-order tests. */
type FetchStub = (
  url: string,
  options: FetchStubOptions,
) => FetchStubResponse | Promise<FetchStubResponse>;
const savedFetchers = new WeakSet<object>();

/** Distinguish a saved global fetch implementation from a fixture stub.
 * @param stub - Fixture operation or previously saved native implementation.
 * @returns Whether restoring this exact saved implementation avoids another wrapper.
 */
function isSavedFetcher(stub: FetchStub): stub is typeof globalThis.fetch {
  return savedFetchers.has(stub);
}

// A local test proxy: concise fixtures become real Responses; restoring a saved fetch
// restores that exact function, rather than stacking wrappers or casting partial responses.
export const fetchStub = {
  /** Save and expose the exact current global fetch so cleanup can restore it without another wrapper.
   * @returns The saved global implementation with its identity registered for restoration.
   */
  get fetch(): FetchStub {
    savedFetchers.add(globalThis.fetch);
    return globalThis.fetch;
  },
  /** Adapt concise fixture replies to real Responses, or restore a previously saved fetch unchanged. */
  set fetch(stub: FetchStub) {
    if (isSavedFetcher(stub)) {
      globalThis.fetch = stub;
      return;
    }
    globalThis.fetch = async (input, init) => {
      if (init?.body != null && typeof init.body !== 'string')
        throw new Error('Fixture adapter requires serialized request text.');
      const reply = await stub(
        input instanceof Request ? input.url : input.toString(),
        {
          ...init,
          body: init?.body ?? '',
        },
      );
      if (reply instanceof Response) return reply;
      const body = reply.json
        ? JSON.stringify(await reply.json())
        : reply.text
          ? await reply.text()
          : null;
      return new Response(body, {
        status: reply.status ?? (reply.ok ? 200 : 500),
      });
    };
  },
};

/** Build isolated Worker bindings with no live-provider dependency.
 * @param overrides - Controlled bindings and partial cache operations for this test.
 * @returns Isolated environment bindings with missing JSON entries and no-op cache writes by default.
 */
export function testEnv(
  overrides: Omit<Partial<Env>, 'SNAPSHOTS'> & {
    SNAPSHOTS?: Partial<SnapshotStore>;
  } = {},
): Env {
  return {
    CORS_ORIGINS: 'https://app.example',
    ...overrides,
    SNAPSHOTS: {
      /** Read the controlled cache or boundary value used by this assertion.
       * @returns An absent cache entry unless overridden by the fixture.
       */
      get: () => Promise.resolve(null),
      /** Observe or simulate the cache write requested by this test. */
      put: async () => {},
      ...overrides.SNAPSHOTS,
    },
  };
}
