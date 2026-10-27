/**
 * Public HTTP response envelopes, correlation and CORS headers.
 * @packageDocumentation
 */

import type { ProviderStop } from './providerRequest.ts';

/** Minimal request boundary used for correlation and authentication headers. */
export interface HeaderRequest {
  headers: Pick<Headers, 'get'>;
}

/** Create or normalize a request identifier for response and diagnostic correlation.
 * @param request - Request exposing the runtime correlation header.
 * @returns Its nonempty cf-ray header or a newly generated UUID.
 */
export function requestId(request: HeaderRequest): string {
  return request.headers.get('cf-ray') || crypto.randomUUID();
}

/** Serialize the response envelope with explicit status, request correlation and CORS headers.
 * @param body - Public response payload to serialize.
 * @param status - HTTP response status.
 * @param requestId - Correlation identifier written to the response header.
 * @param origin - Optional allowed browser origin.
 * @param extraHeaders - Additional response headers, including explicit cache policy overrides.
 * @returns A correlated JSON response with scoped CORS and cache headers.
 */
export function json(
  body: unknown,
  status: number,
  requestId: string,
  origin?: string | null,
  extraHeaders?: Readonly<Record<string, string>>,
): Response {
  const headers = new Headers({
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-request-id': requestId,
  });
  if (origin) headers.set('access-control-allow-origin', origin);
  if (extraHeaders)
    for (const [name, value] of Object.entries(extraHeaders))
      headers.set(name, value);
  return new Response(JSON.stringify(body), { status, headers });
}

/** Build a public error envelope without leaking internal failure details.
 * @param code - Stable public error classification.
 * @param message - Controlled explanation safe for the caller.
 * @param status - HTTP error status.
 * @param requestId - Correlation identifier for this failure.
 * @param origin - Optional allowed browser origin.
 * @param providerStop - Optional sanitized signal to stop queued wallet reads.
 * @returns A non-cacheable public JSON error response.
 */
export function error(
  code: string,
  message: string,
  status: number,
  requestId: string,
  origin?: string | null,
  providerStop?: ProviderStop,
): Response {
  return json(
    {
      error: { code, message, requestId },
      ...(providerStop ? { meta: { requestId, providerStop } } : {}),
    },
    status,
    requestId,
    origin,
  );
}
