/** Consumer and isolation contracts; executable rejection tests live with the pinned shared release guards. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(
  new URL('../.github/workflows/ci.yml', import.meta.url),
  'utf8',
);
const production = readFileSync(
  new URL('../.github/workflows/deploy-production.yml', import.meta.url),
  'utf8',
);
const configuration = readFileSync(
  new URL('../wrangler.toml', import.meta.url),
  'utf8',
);
const config = JSON.parse(
  readFileSync(new URL('../.github/ci-cd.json', import.meta.url), 'utf8'),
);

test('release entry points use the same immutable shared guards without an automatic production trigger', () => {
  for (const file of [workflow, production]) {
    assert.ok(file.includes(`verify-worker.yml@${config.automationSha}`));
    assert.ok(file.includes(`deploy-worker.yml@${config.automationSha}`));
    assert.ok(!file.includes('secrets: inherit'));
  }
  assert.ok(workflow.includes('needs: verify'));
  assert.ok(workflow.includes('environment: dev'));
  assert.ok(workflow.includes("github.ref == 'refs/heads/main'"));
  assert.ok(production.includes('needs: verify_release'));
  assert.ok(production.includes('source_sha: ${{ inputs.sha }}'));
  assert.ok(production.includes('environment: production'));
  assert.doesNotMatch(production, /^ {2}(push|pull_request):/m);
});

test('delivery preserves native target-scoped credentials, prior required checks and explicit refresh semantics', () => {
  assert.deepEqual(config.legacyChecks, ['test']);
  assert.ok(workflow.includes('name: test'));
  assert.ok(workflow.includes('refresh_dev:'));
  const adapter = readFileSync(
    new URL('../scripts/ci-deploy.mjs', import.meta.url),
    'utf8',
  );
  assert.ok(adapter.includes("target === 'production'"));
  assert.ok(adapter.includes("event.inputs?.refresh_dev === 'true'"));
  assert.ok(adapter.includes('/internal/refresh'));
  assert.ok(adapter.includes('publishWorker'));
  assert.ok(!config.deploymentVariables.includes('DEPLOY_ENABLED'));
  assert.ok(
    workflow.includes('IRIS_REFRESH_TOKEN: ${{ secrets.IRIS_REFRESH_TOKEN }}'),
  );
});

test('Worker targets retain local isolation and production-only hourly Cron', () => {
  assert.doesNotMatch(configuration, /\[env\.staging(?:\]|\.)/);
  for (const target of ['local', 'e2e', 'dev', 'production'])
    assert.ok(configuration.includes(`[env.${target}]`));
  assert.doesNotMatch(configuration, /\[env\.dev\.triggers\]/);
  assert.match(
    configuration,
    /\[env\.production\.triggers\]\s+crons = \["0 \* \* \* \*"\]/,
  );
  for (const target of ['local', 'e2e']) {
    const section = configuration
      .split(`[[env.${target}.kv_namespaces]]`)[1]
      ?.split(/^\[/m)[0];
    assert.ok(section?.includes('00000000000000000000000000000000'));
    assert.doesNotMatch(section, /remote\s*=\s*true/);
  }
});

test('hosted Workers bind distinct new namespaces, not retired resources', () => {
  const namespaces = new Set<string>();
  const retired = new Set([
    '837c0562b3844757b252f0324dc70b74',
    'd9cc2796e2954a498851b3ad5ecefd59',
    '8409635b839c49558d1b6e9bdeaf0f03',
  ]);
  for (const target of ['dev', 'production']) {
    const worker = configuration.split(`[env.${target}]`)[1]?.split(/^\[/m)[0];
    assert.ok(worker?.includes(`name = "iris-backend-${target}"`));
    assert.match(worker, /workers_dev = true/);
    const binding = configuration
      .split(`[[env.${target}.kv_namespaces]]`)[1]
      ?.split(/^\[/m)[0];
    const id = binding?.match(/^id = "([0-9a-f]{32})"/m)?.[1];
    assert.ok(id);
    assert.notEqual(id, '00000000000000000000000000000000');
    assert.equal(retired.has(id), false);
    namespaces.add(id);
  }
  assert.equal(namespaces.size, 2);
});

test('hosted Workers explicitly disable version previews without disabling their APIs', () => {
  for (const target of ['dev', 'production']) {
    const worker = configuration.split(`[env.${target}]`)[1]?.split(/^\[/m)[0];
    assert.ok(worker);
    assert.match(worker, /^workers_dev = true\s*$/m);
    assert.match(worker, /^preview_urls = false\s*$/m);
  }
});
