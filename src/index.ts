/**
 * Application entry point and runtime integration boundaries.
 * @packageDocumentation
 */

import { getConfig, type WorkerConfig } from './config.ts';
import { error, json, requestId } from './http.ts';
import { route } from './routes.ts';
import { refreshSnapshot } from './snapshot.ts';
import { refreshHeliusDashboardSample } from './recentTransactions.ts';
import { refreshDefiLlamaDashboard } from './defillama.ts';
import type { Env } from './env.ts';
import { errorMessage } from './record.ts';
import { diagnostic, unavailable, refreshDiagnostic } from './diagnostics.ts';
import { watchlistRoute } from './watchlists.ts';

/** Request boundary accepted by the Worker routing implementation. */
interface WorkerRequest {
  url: string;
  method: string;
  headers: {
    /** Read an HTTP request header without depending on a concrete Headers instance.
     * @param name - Case-insensitive header name.
     * @returns Its value or null when absent.
     */
    get: (name: string) => string | null;
  };
  body?: ReadableStream<Uint8Array> | null;
}

/** Resolve the permitted browser origin from the validated Worker configuration.
 * @param request - Incoming request carrying an optional browser origin.
 * @param config - Validated CORS allowlist.
 * @returns The allowed origin, or null for absent/denied origins.
 */
function allowedOrigin(
  request: WorkerRequest,
  config: WorkerConfig,
): string | null {
  const origin = request.headers.get('origin');
  return origin && config.corsOrigins.includes(origin) ? origin : null;
}

/** Refresh dashboard data independently of browser traffic as scheduled backstop work.
 * @param env - Dashboard cache and provider bindings.
 * @param config - Effective selected provider settings.
 */
async function refreshHeliusDashboardBackstop(env: Env, config: WorkerConfig) {
  try {
    await refreshHeliusDashboardSample(env, config);
  } catch (cause) {
    // Snapshot publication must not fail because the optional live dashboard cache is unavailable.
    unavailable('dashboard-refresh', 'Helius', cause);
  }
}

/** Refresh the external dashboard cache without making browser reads responsible for scheduled upkeep.
 * @param env - Dashboard cache and stale-retention policy bindings.
 */
async function refreshDefiLlamaBackstop(env: Env) {
  try {
    await refreshDefiLlamaDashboard(
      env.SNAPSHOTS,
      new Date(),
      env.RETAIN_STALE_MARKET_DATA === 'true',
    );
  } catch (cause) {
    // DefiLlama is an optional dashboard source and must not block core snapshots.
    unavailable('defillama-refresh', 'DefiLlama', cause);
  }
}

const worker = {
  /** Handle the incoming HTTP request using the environment bindings supplied by the runtime.
   * @param request - Incoming HTTP request at the Worker boundary.
   * @param env - Selected runtime bindings and configuration.
   * @param _ctx - Optional runtime context; refresh work is awaited explicitly.
   * @returns A correlated public or authenticated private response.
   */
  async fetch(
    request: WorkerRequest,
    env: Env,
    _ctx?: unknown,
  ): Promise<Response> {
    const id = requestId(request);
    let config;
    try {
      config = getConfig(env);
    } catch (cause) {
      return error('CONFIGURATION_ERROR', errorMessage(cause), 500, id);
    }
    const origin = allowedOrigin(request, config);
    if (request.headers.get('origin') && !origin)
      return error('CORS_ORIGIN_DENIED', 'Origin is not allowed.', 403, id);
    if (request.method === 'OPTIONS') {
      const privatePath = new URL(request.url).pathname.startsWith('/v3/me/');
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': String(origin),
          'access-control-allow-methods': privatePath
            ? 'GET, PUT, DELETE, OPTIONS'
            : 'GET, POST, OPTIONS',
          'access-control-allow-headers':
            'content-type, x-request-id, authorization',
          'access-control-max-age': '86400',
          'x-request-id': id,
        },
      });
    }
    if (
      request.method === 'POST' &&
      new URL(request.url).pathname === '/internal/refresh'
    ) {
      const expectedToken = env.REFRESH_TOKEN;
      if (
        !expectedToken ||
        request.headers.get('authorization') !== `Bearer ${expectedToken}`
      )
        return error(
          'REFRESH_UNAUTHORIZED',
          'Refresh authorization is invalid.',
          401,
          id,
          origin,
        );
      try {
        const [snapshot] = await refreshDiagnostic(
          'authenticated-refresh',
          () =>
            Promise.all([
              refreshSnapshot(env, config),
              refreshHeliusDashboardBackstop(env, config),
              refreshDefiLlamaBackstop(env),
            ]),
          id,
        );
        return json(
          {
            data: { status: 'refreshed', createdAt: snapshot.createdAt },
            meta: { requestId: id },
          },
          200,
          id,
          origin,
          { 'cache-control': 'no-store' },
        );
      } catch {
        return error(
          'REFRESH_FAILED',
          'The snapshot refresh could not be completed.',
          502,
          id,
          origin,
        );
      }
    }
    if (new URL(request.url).pathname.startsWith('/v3/me/'))
      return watchlistRoute(request, env, id, origin);
    if (request.method !== 'GET')
      return error(
        'METHOD_NOT_ALLOWED',
        'Only GET is supported.',
        405,
        id,
        origin,
      );
    try {
      return await route(request, env, config, id, origin);
    } catch (cause) {
      unavailable('http-request', '', cause, id);
      return error(
        'INTERNAL_ERROR',
        'The request could not be completed.',
        500,
        id,
        origin,
      );
    }
  },
  /** Run bounded background refresh or delivery work for the scheduled invocation.
   * @param _event - Platform schedule event; refresh eligibility comes from configuration.
   * @param env - Selected cache and provider bindings.
   * @param _ctx - Optional runtime context; all scheduled refreshes are awaited.
   */
  async scheduled(
    this: void,
    _event: unknown,
    env: Env,
    _ctx?: unknown,
  ): Promise<void> {
    await refreshDiagnostic('scheduled-refresh', async () => {
      const config = getConfig(env);
      await Promise.all([
        refreshSnapshot(env, config),
        refreshHeliusDashboardBackstop(env, config),
        refreshDefiLlamaBackstop(env),
      ]);
    });
  },
};

export default {
  /** Handle the incoming HTTP request using the environment bindings supplied by the runtime.
   * @param request - Incoming HTTP request to route and measure.
   * @param env - Selected runtime bindings and configuration.
   * @param ctx - Optional runtime context forwarded to the request handler.
   * @returns The routed response after emitting bounded request diagnostics.
   */
  async fetch(
    request: WorkerRequest,
    env: Env,
    ctx?: unknown,
  ): Promise<Response> {
    const started = Date.now();
    const response = await worker.fetch(request, env, ctx);
    diagnostic({
      event: 'request',
      operation: 'http-request',
      outcome: response.status < 400 ? 'completed' : 'failed',
      requestId: response.headers.get('x-request-id') ?? undefined,
      method: request.method,
      status: response.status,
      durationMs: Date.now() - started,
    });
    return response;
  },
  scheduled: worker.scheduled,
};
