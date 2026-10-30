/**
 * Regression coverage and controlled fixtures for delivery.
 * @packageDocumentation
 */

/** Consumer and isolation contracts; executable rejection tests live with the pinned shared release guards. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { record } from '../../src/record.ts';
import config from '../../.github/ci-cd.json' with { type: 'json' };

const workflow = readFileSync(
  new URL('../../.github/workflows/verify-and-deploy-dev.yml', import.meta.url),
  'utf8',
);
const production = readFileSync(
  new URL(
    '../../.github/workflows/verify-and-deploy-prod.yml',
    import.meta.url,
  ),
  'utf8',
);
const configuration = readFileSync(
  new URL('../../wrangler.toml', import.meta.url),
  'utf8',
);
const pr = readFileSync(
  new URL('../../.github/workflows/verify-pr.yml', import.meta.url),
  'utf8',
);

/** Check every parsed shared job reference and its revision input, including quoted YAML values.
 * @param file - Workflow YAML to inspect.
 */
function assertSharedPins(file: string) {
  const parsed: unknown = parse(file);
  const prefix = 'benhammoush/ci-cd-workflows/.github/workflows/';
  let references = 0;
  for (const value of Object.values(record(record(parsed).jobs))) {
    const job = record(value);
    if (typeof job.uses !== 'string' || !job.uses.startsWith(prefix)) continue;
    references++;
    const path = job.uses.split('@')[0];
    assert.equal(job.uses, `${path}@${config.automationSha}`);
    const input = record(job.with).automation_sha;
    if (path !== `${prefix}weekly-vuln-audit.yml` || input !== undefined)
      assert.equal(input, config.automationSha);
  }
  assert.ok(references > 0);
}

void test('all shared workflow references and inputs match the configured immutable revision', () => {
  assert.match(config.automationSha, /^[a-f0-9]{40}$/);
  const audit = readFileSync(
    new URL('../../.github/workflows/weekly-vuln-audit.yml', import.meta.url),
    'utf8',
  );
  for (const file of [pr, workflow, production, audit]) assertSharedPins(file);
});

void test('a valid pinned job cannot hide a quoted unpinned job or mismatched revision input', () => {
  const pinned = `jobs:
  audit:
    uses: "benhammoush/ci-cd-workflows/.github/workflows/weekly-vuln-audit.yml@${config.automationSha}"
`;
  assertSharedPins(pinned);
  for (const quote of ['"', "'"]) {
    assert.throws(() =>
      assertSharedPins(`${pinned}
  additional:
    uses: ${quote}benhammoush/ci-cd-workflows/.github/workflows/verify-worker.yml@main${quote}
    with:
      automation_sha: ${config.automationSha}
`),
    );
  }
  assert.throws(() =>
    assertSharedPins(`${pinned}
  additional:
    uses: "benhammoush/ci-cd-workflows/.github/workflows/verify-worker.yml@${config.automationSha}"
    with:
      automation_sha: main
`),
  );
});

void test('release entry points use the same immutable shared guards without an automatic production trigger', () => {
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

void test('delivery preserves target-scoped credentials and refresh semantics with the canonical Verify check', () => {
  assert.deepEqual(config.legacyChecks, []);
  assert.match(
    pr,
    /verify_result:\s+(?:#[^\n]*\s+)?name: Verify\s+needs: verify\s+if: always\(\)/,
  );
  assert.ok(pr.includes('test "$VERIFY_RESULT" = success'));
  assert.ok(pr.includes('VERIFY_RESULT: ${{ needs.verify.result }}'));
  assert.doesNotMatch(workflow, /legacy_\d+:/);
  assert.ok(workflow.includes('refresh_dev:'));
  const adapter = readFileSync(
    new URL('../../scripts/ci-deploy.mjs', import.meta.url),
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

void test('Worker targets retain local isolation and separate dev cleanup from production market Cron', () => {
  assert.doesNotMatch(configuration, /\[env\.staging(?:\]|\.)/);
  for (const target of ['local', 'e2e', 'dev', 'production'])
    assert.ok(configuration.includes(`[env.${target}]`));
  assert.match(
    configuration,
    /\[env\.dev\.triggers\]\s+crons = \["17 \* \* \* \*"\]/,
  );
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

void test('watchlist cleanup is enabled only in isolated dev while account traffic stays disabled', () => {
  const variables = configuration.split('[env.dev.vars]')[1]?.split(/^\[/m)[0];
  assert.ok(variables);
  assert.match(variables, /^WATCHLIST_ENABLED = "false"$/m);
  assert.match(variables, /^WATCHLIST_CLEANUP_ENABLED = "true"$/m);
  assert.match(variables, /^FIREBASE_PROJECT_ID = "iris-watchlists-dev"$/m);
  const database = configuration
    .split('[[env.dev.d1_databases]]')[1]
    ?.split(/^\[/m)[0];
  assert.ok(database);
  assert.match(database, /^binding = "WATCHLIST_DB"$/m);
  assert.match(database, /^database_name = "iris-watchlists-dev"$/m);
  assert.match(
    database,
    /^database_id = "3e6a5cab-b33c-4e3f-ae01-9f3f222efa81"$/m,
  );
  assert.doesNotMatch(database, /^migrations_dir\s*=/m);
  assert.equal((configuration.match(/\.d1_databases\]\]/g) ?? []).length, 1);
  const limiter = configuration
    .split('[[env.dev.ratelimits]]')[1]
    ?.split(/^\[/m)[0];
  assert.ok(limiter);
  assert.match(limiter, /^name = "WATCHLIST_RATE_LIMITER"$/m);
  assert.match(limiter, /^namespace_id = "2026102901"$/m);
  assert.match(limiter, /^simple = \{ limit = 60, period = 60 \}$/m);
  assert.equal((configuration.match(/\.ratelimits\]\]/g) ?? []).length, 1);
  assert.doesNotMatch(configuration, /^FIREBASE_PRIVATE_KEY\s*=/m);
  assert.doesNotMatch(configuration, /^WATCHLIST_RECEIPT_KEY\s*=/m);
  for (const target of ['local', 'e2e', 'production']) {
    const variables = configuration
      .split(`[env.${target}.vars]`)[1]
      ?.split(/^\[/m)[0];
    assert.doesNotMatch(
      variables ?? '',
      /^WATCHLIST_(?:CLEANUP_)?ENABLED = "true"$/m,
    );
  }
});

void test('hosted Workers bind distinct new namespaces, not retired resources', () => {
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

void test('hosted Workers explicitly disable version previews without disabling their APIs', () => {
  for (const target of ['dev', 'production']) {
    const worker = configuration.split(`[env.${target}]`)[1]?.split(/^\[/m)[0];
    assert.ok(worker);
    assert.match(worker, /^workers_dev = true\s*$/m);
    assert.match(worker, /^preview_urls = false\s*$/m);
  }
});
