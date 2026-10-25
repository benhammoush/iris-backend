/**
 * Public HTTP response envelopes, correlation and CORS headers.
 * @packageDocumentation
 */

/** Create or normalize a request identifier for response and diagnostic correlation. */
export function requestId(request: { headers: Pick<Headers, 'get'> }): string {
  return request.headers.get('cf-ray') || crypto.randomUUID();
}

/** Serialize the response envelope with explicit status, request correlation and CORS headers. */
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

/** Build a public error envelope without leaking internal failure details. */
export function error(
  code: string,
  message: string,
  status: number,
  requestId: string,
  origin?: string | null,
): Response {
  return json(
    { error: { code, message, requestId } },
    status,
    requestId,
    origin,
  );
}
