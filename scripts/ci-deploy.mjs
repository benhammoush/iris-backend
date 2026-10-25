/** Deliver the tested Worker while preserving isolated namespaces, preview policy and explicit refresh semantics.
 * @file
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const env = process.env;
const target = env.CI_ENVIRONMENT;
assert.ok(['dev', 'production'].includes(target));
assert.equal(
  env.IRIS_WORKER_ORIGIN,
  `https://iris-backend-${target}.benhxm.workers.dev`,
);
const text = readFileSync('wrangler.toml', 'utf8');
const { workerConfiguration } = await import(
  pathToFileURL(
    resolve(env.CI_AUTOMATION_ROOT, 'scripts/worker-configuration.mjs'),
  ).href
);
const safeConfiguration = workerConfiguration(text, target);
writeFileSync('wrangler.delivery.json', JSON.stringify(safeConfiguration));
assert.ok(
  !/\[build\]/.test(text),
  'Historical custom build commands are not allowed during privileged delivery',
);
const start = text.indexOf(`[env.${target}]`);
assert.ok(start >= 0);
const next = text
  .slice(start + 1)
  .search(/\[env\.(?:local|dev|e2e|production)\]/);
const section = text.slice(start, next < 0 ? undefined : start + 1 + next);
assert.ok(section.includes(`name = "iris-backend-${target}"`));
assert.ok(section.includes('preview_urls = false'));
assert.ok(
  section.includes(
    target === 'dev'
      ? '5bedf23d861c4e5d8a72afc9305bbf46'
      : '4442b6231710407ea3a668dc9a8a8794',
  ),
);
assert.ok(section.includes(`https://iris-frontend-${target}.vercel.app`));
if (target === 'production') {
  assert.ok(!section.includes('localhost'));
  assert.ok(section.includes('crons = ["0 * * * *"]'));
}
const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
const refresh =
  target === 'production' ||
  (env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
    event.inputs?.refresh_dev === 'true');
if (refresh)
  assert.ok(env.IRIS_REFRESH_TOKEN, 'Missing explicit refresh credential');
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const { publishWorker } = await import(
  pathToFileURL(resolve(env.CI_AUTOMATION_ROOT, 'scripts/providers.mjs')).href
);
await publishWorker(env, {
  name: `iris-backend-${target}`,
  config: 'wrangler.delivery.json',
  entry: 'dist/index.js',
  configuration: { wrangler: text, origin: env.IRIS_WORKER_ORIGIN },
  /** Preserve the approved production refresh and separately requested manual dev refresh, once only. */
  smoke: async (fetcher) => {
    if (refresh) {
      const response = await fetcher(
        `${env.IRIS_WORKER_ORIGIN}/internal/refresh`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.IRIS_REFRESH_TOKEN}` },
          redirect: 'error',
          signal: AbortSignal.timeout(120_000),
        },
      );
      assert.ok(
        response.ok,
        'Refresh failed; inspect data/provider state before a new dispatch',
      );
    }
    for (const path of ['/health', '/ready']) {
      const response = await fetcher(`${env.IRIS_WORKER_ORIGIN}${path}`, {
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      if (path === '/health') assert.equal(body.data?.version, version);
    }
  },
});
