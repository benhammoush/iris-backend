/**
 * Exercises the workflow's manual release guard without Git or provider access.
 * Structural checks protect the remaining delivery controls, not live policy.
 * @packageDocumentation
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const workflow = readFileSync(
  new URL('../.github/workflows/ci.yml', import.meta.url),
  'utf8',
).replace(/\r/g, '');
const configuration = readFileSync(
  new URL('../wrangler.toml', import.meta.url),
  'utf8',
);
const bash =
  process.platform === 'win32'
    ? (process.env.IRIS_TEST_BASH ??
      join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/bin/bash.exe'))
    : 'bash';

/**
 * Runs the actual pre-checkout validation step with controlled public inputs.
 * GitHub's merged-ancestor check is separate and is checked structurally below.
 * @param target - Requested hosted deployment target.
 * @param sha - Candidate source identity, not a repository checkout.
 * @param ref - Workflow branch; only main may manually release.
 * @returns The Bash exit status; interpreter errors fail rather than skip tests.
 */
function validateRelease(target: string, sha: string, ref: string) {
  const script = workflow.match(
    /- name: Validate manual release[\s\S]*?run: \|\n((?: {10}[^\n]*\n)+)/,
  )?.[1];
  assert.ok(script, 'Missing manual validation step');
  const result = spawnSync(bash, ['-e', '-c', script.replace(/^ {10}/gm, '')], {
    env: {
      ...process.env,
      TARGET: target,
      SOURCE_SHA: sha,
      GITHUB_REF: ref,
    },
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.error) throw result.error;
  assert.notEqual(result.status, null, result.stderr);
  return result.status;
}

test('manual releases accept only dev and production with exact source on main', () => {
  for (const target of ['dev', 'production']) {
    assert.equal(validateRelease(target, 'a'.repeat(40), 'refs/heads/main'), 0);
  }
  for (const target of ['staging', 'local', '', 'Production', 'dev; exit 0']) {
    assert.notEqual(
      validateRelease(target, 'a'.repeat(40), 'refs/heads/main'),
      0,
    );
  }
  for (const sha of [
    '',
    'main',
    'a'.repeat(39),
    'a'.repeat(41),
    'G'.repeat(40),
  ]) {
    assert.notEqual(validateRelease('dev', sha, 'refs/heads/main'), 0);
  }
  assert.notEqual(
    validateRelease('production', 'a'.repeat(40), 'refs/heads/feature'),
    0,
  );
});

test('delivery retains source, main, approval environment and serialization controls', () => {
  assert.match(workflow, /options: \[dev, production\]/);
  assert.match(workflow, /TARGET: \$\{\{ inputs\.target \|\| 'dev' \}\}/);
  assert.match(workflow, /git merge-base --is-ancestor HEAD origin\/main/);
  assert.equal(workflow.match(/ref: \$\{\{ env\.SOURCE_SHA \}\}/g)?.length, 2);
  assert.match(workflow, /needs: test/);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /environment: \$\{\{ inputs\.target \|\| 'dev' \}\}/);
  assert.match(
    workflow,
    /group: iris-worker-\$\{\{ inputs\.target \|\| 'dev' \}\}/,
  );
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /test "\$DEPLOY_ENABLED" = true/);
  assert.match(
    workflow,
    /if \[ "\$GITHUB_EVENT_NAME" = push \]; then\n\s+git fetch origin main\n\s+test "\$\(git rev-parse origin\/main\)" = "\$SOURCE_SHA"/,
  );
  assert.match(
    workflow,
    /if \[ "\$TARGET" != dev \] \|\| \[ "\$REFRESH_DEV" = true \]; then/,
  );
});

test('Worker targets retain local isolation and production-only hourly Cron', () => {
  assert.doesNotMatch(configuration, /\[env\.staging(?:\]|\.)/);
  for (const target of ['local', 'e2e', 'dev', 'production']) {
    assert.ok(configuration.includes(`[env.${target}]`));
  }
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

test('hosted Workers bind distinct new namespaces with explicit workers.dev routes', () => {
  const namespaces = new Set<string>();
  const retiredNamespaces = new Set([
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
    assert.ok(id, `Missing ${target} namespace`);
    assert.notEqual(id, '00000000000000000000000000000000');
    assert.equal(retiredNamespaces.has(id), false);
    namespaces.add(id);
  }
  assert.equal(namespaces.size, 2);
});
