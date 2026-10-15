export function requestId(request: { headers: Pick<Headers, 'get'> }): string {
  return request.headers.get('cf-ray') || crypto.randomUUID();
}

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
