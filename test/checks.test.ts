import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const { scripts } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { scripts: Record<string, string> };

test('check owns every CI quality stage exactly once and ends in a dry-run build', () => {
  const check = scripts.check.split(' && ');
  assert.deepEqual(check, [
    'npm run lint',
    'npm run format:check',
    'npm run check:tooling',
    'npm run audit:dependencies',
    'npm run check:versions',
    'npm run check:types',
    'npm run lint:openapi',
    'npm test',
    'npm run test:merge-policy',
    'npm run build',
  ]);
  assert.equal(scripts.build, 'wrangler deploy --dry-run --env production');
  const workflow = readFileSync(
    new URL('../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  );
  const qualityJob = workflow.slice(
    workflow.indexOf('\n  test:'),
    workflow.indexOf('\n  deploy:'),
  );
  const stages = [...qualityJob.matchAll(/- run: (.+)/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(stages, ['npm ci', 'npm run check']);
});
