/**
 * Regression coverage and controlled fixtures for production cors.
 * @packageDocumentation
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../../src/index.ts';
import { testEnv } from '../support/support.ts';

const configuration = readFileSync(
  new URL('../../wrangler.toml', import.meta.url),
  'utf8',
);
const dashboardOrigin = 'https://iris-frontend-production.vercel.app';

/** Build isolated environment bindings for the exercised request. */
function env(environment: string) {
  const section = configuration
    .split(`[env.${environment}.vars]`)[1]
    ?.split(/^\[/m)[0];
  const origins = section?.match(/^CORS_ORIGINS = "([^"]+)"/m)?.[1];
  assert.ok(origins, `Missing ${environment} CORS configuration`);
  return testEnv({ CORS_ORIGINS: origins });
}

test('production configuration allows only the production dashboard origin', () => {
  assert.equal(env('production').CORS_ORIGINS, dashboardOrigin);
});

test('production permits dashboard GET requests and preflight', async () => {
  for (const method of ['GET', 'OPTIONS']) {
    const response = await worker.fetch(
      new Request('https://api.example/v3/assets', {
        method,
        headers: { origin: dashboardOrigin },
      }),
      env('production'),
      {},
    );
    assert.equal(response.status, method === 'GET' ? 200 : 204);
    assert.equal(
      response.headers.get('access-control-allow-origin'),
      dashboardOrigin,
    );
  }
});

test('production denies local and other environment origins for GET and preflight', async () => {
  for (const origin of [
    'http://localhost:3000',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'https://iris-frontend-dev.vercel.app',
    'https://retired-frontend.example.invalid',
    'https://iris-dashboard-phi.vercel.app',
    'https://iris-dev.vercel.app',
    'https://iris-staging-orcin.vercel.app',
  ]) {
    for (const method of ['GET', 'OPTIONS']) {
      const response = await worker.fetch(
        new Request('https://api.example/v3/assets', {
          method,
          headers: { origin },
        }),
        env('production'),
        {},
      );
      assert.equal(response.status, 403, `${method} ${origin}`);
      assert.equal(response.headers.get('access-control-allow-origin'), null);
      assert.equal((await response.json()).error.code, 'CORS_ORIGIN_DENIED');
    }
  }
});

test('dev localhost and originless production health checks remain permitted', async () => {
  const dev = await worker.fetch(
    new Request('https://api.example/health', {
      headers: { origin: 'http://localhost:5173' },
    }),
    env('dev'),
    {},
  );
  assert.equal(dev.status, 200);
  assert.equal(
    dev.headers.get('access-control-allow-origin'),
    'http://localhost:5173',
  );
  const production = await worker.fetch(
    new Request('https://api.example/health'),
    env('production'),
    {},
  );
  assert.equal(production.status, 200);
});
