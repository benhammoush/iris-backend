/**
 * Bounded provider requests, controlled retries and classified failures.
 * @packageDocumentation
 */

import { diagnostic } from './diagnostics.ts';

/** Supported provider failure categories for safe diagnostics and retry decisions. */
export type ProviderFailure = 'http' | 'network' | 'timeout' | 'json';

/** Provider failure retaining only provider identity, category and optional HTTP status. */
export class ProviderRequestError extends Error {
  /** Retain a controlled provider-failure classification, never raw upstream details.
   * @param provider - Trusted provider label selected by application code.
   * @param kind - Supported failure category.
   * @param status - Optional HTTP failure status.
   */
  constructor(
    readonly provider: string,
    readonly kind: ProviderFailure,
    readonly status: number | null = null,
  ) {
    super(
      kind === 'http'
        ? `${provider} request failed with ${status}`
        : `${provider} request failed (${kind})`,
    );
    this.name = 'ProviderRequestError';
  }
}

const RETRY_STATUSES = new Set([429, 502, 503, 504]);

/** Combine Retry-After with jitter; the caller rejects delays beyond its remaining deadline.
 * @param response - Optional failed response carrying Retry-After.
 * @returns The greater of jitter and a valid server-requested delay, in milliseconds.
 */
function retryDelay(response?: Response): number {
  const jitter = 250 + Math.floor(Math.random() * 251);
  const value = response?.headers?.get('retry-after')?.trim();
  if (!value) return jitter;
  const milliseconds = /^\d+$/.test(value)
    ? Number(value) * 1000
    : Date.parse(value) - Date.now();
  return Number.isFinite(milliseconds)
    ? Math.max(jitter, milliseconds)
    : jitter;
}

/** Provider read policy with an overall deadline. */
interface ProviderReadOptions {
  provider: string;
  timeoutMs?: number;
  readOnlyPost?: boolean;
}

/** Only provider reads belong here; POST callers must explicitly identify a read.
 * @param url - Trusted operator-configured provider endpoint.
 * @param init - Read-only request options; caller cancellation is not accepted here.
 * @param options - Provider label, overall deadline and explicit read-only POST classification.
 * @returns Unknown provider JSON after at most one supported retry within the shared deadline.
 */
export async function providerJson(
  url: string,
  init: Omit<RequestInit, 'signal'>,
  options: ProviderReadOptions,
): Promise<unknown> {
  const { provider, timeoutMs = 10_000 } = options;
  const method = (init.method ?? 'GET').toUpperCase();
  if (
    (method !== 'GET' && !(method === 'POST' && options.readOnlyPost)) ||
    (init.body != null && typeof init.body !== 'string') ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw new Error('Invalid provider read configuration');
  }
  const controller = new AbortController();
  const started = Date.now();
  const operationId = crypto.randomUUID();
  let attempts = 0;
  const deadline = Date.now() + timeoutMs;
  const timeoutError = new ProviderRequestError(provider, 'timeout');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timeoutError);
    }, timeoutMs);
  });
  /** Attempt the provider read at most twice within the shared overall deadline.
   * @returns Unknown response JSON, rejecting controlled transport, HTTP, timeout or parsing failures.
   */
  async function run(): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (controller.signal.aborted || Date.now() >= deadline)
        throw timeoutError;
      let response: Response | undefined;
      attempts = attempt + 1;
      let failure: ProviderRequestError;
      try {
        response = await fetch(url, { ...init, signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) throw timeoutError;
        failure = new ProviderRequestError(provider, 'network');
        // Fetch transport failures are TypeErrors; programming errors are not retried.
        if (!(error instanceof TypeError)) throw failure;
      }
      if (controller.signal.aborted || Date.now() >= deadline)
        throw timeoutError;
      if (response?.ok) {
        try {
          const payload: unknown = await response.json();
          if (controller.signal.aborted || Date.now() >= deadline)
            throw timeoutError;
          return payload;
        } catch {
          if (controller.signal.aborted || Date.now() >= deadline)
            throw timeoutError;
          throw new ProviderRequestError(provider, 'json');
        }
      }
      if (response) {
        failure = new ProviderRequestError(provider, 'http', response.status);
        if (!RETRY_STATUSES.has(response.status)) throw failure;
      } else {
        failure = new ProviderRequestError(provider, 'network');
      }
      if (attempt === 1) throw failure;
      const delay = retryDelay(response);
      if (delay >= deadline - Date.now()) throw failure;
      diagnostic({
        event: 'provider',
        operation: 'provider-read',
        outcome: 'retry',
        provider,
        operationId,
        method,
        attempt: attempts,
        status: failure.status,
        cause: failure,
        durationMs: Date.now() - started,
      });
      // Release an unsuccessful response before repeating a read.
      await response?.body?.cancel().catch(() => {});
      await new Promise<void>((resolve) => {
        const wait = setTimeout(done, delay);
        /** Finish the pending request once and release its owned deadline or listener resources. */
        function done() {
          clearTimeout(wait);
          controller.signal.removeEventListener('abort', done);
          resolve();
        }
        controller.signal.addEventListener('abort', done, { once: true });
        if (controller.signal.aborted) done();
      });
    }
    throw new ProviderRequestError(provider, 'network');
  }
  try {
    return await Promise.race([run(), timeout]);
  } catch (cause) {
    diagnostic({
      event: 'provider',
      operation: 'provider-read',
      outcome: 'failed',
      provider,
      operationId,
      method,
      attempt: attempts,
      status: cause instanceof ProviderRequestError ? cause.status : null,
      cause,
      durationMs: Date.now() - started,
    });
    throw cause;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
