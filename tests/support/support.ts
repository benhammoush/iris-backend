/**
 * Regression coverage and controlled fixtures for support.
 * @packageDocumentation
 */

import type { Env, SnapshotStore } from '../../src/env.ts';

/** Fetch input shape accepted by the isolated provider test adapter. */
export interface FetchStubOptions extends Omit<RequestInit, 'body'> {
  body: string;
}

/** Minimal provider-response capabilities exposed by the test adapter. */
interface FetchStubResponse {
  ok: boolean;
  status?: number;
  /** Return the controlled JSON payload for this provider-response fixture. */
  json?: () => Promise<unknown>;
  /** Return the controlled text body for this provider-response fixture. */
  text?: () => Promise<string>;
}

/** Controlled provider request function used in place of global fetch. */
type FetchStub = (
  url: string,
  options: FetchStubOptions,
) => Promise<FetchStubResponse>;
const savedFetchers = new WeakSet<object>();

/** Distinguish a saved global fetch implementation from a fixture stub. */
function isSavedFetcher(stub: FetchStub): stub is typeof globalThis.fetch {
  return savedFetchers.has(stub);
}

// A local test proxy: concise fixtures become real Responses; restoring a saved fetch
// restores that exact function, rather than stacking wrappers or casting partial responses.
export const fetchStub = {
  /** Save and expose the exact current global fetch so cleanup can restore it without another wrapper. */
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
      const reply = await stub(String(input), {
        ...init,
        body: String(init?.body ?? ''),
      });
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

/** Build isolated Worker bindings with no live-provider dependency. */
export function testEnv(
  overrides: Omit<Partial<Env>, 'SNAPSHOTS'> & {
    SNAPSHOTS?: Partial<SnapshotStore>;
  } = {},
): Env {
  return {
    CORS_ORIGINS: 'https://app.example',
    ...overrides,
    SNAPSHOTS: {
      /** Read the controlled cache or boundary value used by this assertion. */
      get: async () => null,
      /** Observe or simulate the cache write requested by this test. */
      put: async () => {},
      ...overrides.SNAPSHOTS,
    },
  };
}
