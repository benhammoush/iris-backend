import type { Env, SnapshotStore } from '../src/env.ts';

export interface FetchStubOptions extends Omit<RequestInit, 'body'> {
  body: string;
}

interface FetchStubResponse {
  ok: boolean;
  status?: number;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
}

type FetchStub = (
  url: string,
  options: FetchStubOptions,
) => Promise<FetchStubResponse>;
const savedFetchers = new WeakSet<object>();

function isSavedFetcher(stub: FetchStub): stub is typeof globalThis.fetch {
  return savedFetchers.has(stub);
}

// A local test proxy: concise fixtures become real Responses; restoring a saved fetch
// restores that exact function, rather than stacking wrappers or casting partial responses.
export const fetchStub = {
  get fetch(): FetchStub {
    savedFetchers.add(globalThis.fetch);
    return globalThis.fetch;
  },
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

export function testEnv(
  overrides: Omit<Partial<Env>, 'SNAPSHOTS'> & {
    SNAPSHOTS?: Partial<SnapshotStore>;
  } = {},
): Env {
  return {
    CORS_ORIGINS: 'https://app.example',
    ...overrides,
    SNAPSHOTS: {
      get: async () => null,
      put: async () => {},
      ...overrides.SNAPSHOTS,
    },
  };
}
