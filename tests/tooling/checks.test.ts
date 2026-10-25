/**
 * Regression coverage and controlled fixtures for checks.
 * @packageDocumentation
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import { record } from '../../src/record.ts';

const { scripts } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { scripts: Record<string, string> };

void test('check owns every CI quality stage exactly once and ends in a dry-run build', () => {
  const check = scripts.check.split(' && ');
  assert.deepEqual(check, [
    'npm run lint',
    'npm run format:check',
    'npm run check:tooling',
    'npm run audit:dependencies',
    'npm run check:version',
    'npm run typecheck',
    'npm run lint:openapi',
    'npm test',
    'npm run test:merge-policy',
    'npm run build',
  ]);
  assert.equal(scripts.build, 'wrangler deploy --dry-run --env production');
  const workflow = record(
    parse(
      readFileSync(
        new URL('../../.github/workflows/verify-pr.yml', import.meta.url),
        'utf8',
      ),
    ),
  );
  const jobs = record(workflow.jobs);
  assert.match(
    String(record(jobs.verify).uses),
    /^benhammoush\/ci-cd-workflows\/\.github\/workflows\/verify-worker.yml@[a-f0-9]{40}$/,
  );
  assert.equal(scripts['ci:quality'], 'npm run check');
  assert.equal(scripts.typecheck, scripts['check:types']);
  assert.equal(scripts['check:version'], scripts['check:versions']);
  assert.equal(record(jobs.verify_result).name, 'Verify');
  assert.equal(record(jobs.verify_result).needs, 'verify');
});
