import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { record } from '../src/record.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = path.join(root, 'scripts/lint-openapi.mjs');
const document = {
  openapi: '3.0.3',
  info: {
    title: 'Lint regression',
    version: '1.0.0',
    license: { name: 'MIT', url: 'https://opensource.org/licenses/MIT' },
  },
  servers: [{ url: 'https://iris-backend-production.example.invalid' }],
  security: [],
  paths: {
    '/health': {
      get: {
        operationId: 'health',
        // Deliberately omit summary and a 4xx response: both are approved exceptions.
        responses: { 200: { description: 'Healthy' } },
      },
    },
  },
};

function runDocument(value: unknown) {
  const directory = mkdtempSync(path.join(tmpdir(), 'iris-lint-'));
  try {
    const file = path.join(directory, 'openapi.json');
    writeFileSync(
      file,
      typeof value === 'string' ? value : JSON.stringify(value),
    );
    const result = spawnSync(process.execPath, [script, file], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.ifError(result.error);
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('core lint accepts the Iris contract', () => {
  const result = runDocument(
    readFileSync(path.join(root, 'openapi.yaml'), 'utf8'),
  );
  assert.equal(result.status, 0, result.output);
});

test('core lint preserves both approved exceptions', () => {
  const result = runDocument(document);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /0 error\(s\), 0 warning\(s\)/);
});

test('core lint fails on recommended-rule errors with useful diagnostics', () => {
  const invalid = structuredClone(document);
  delete record(invalid.paths['/health'].get).responses;
  const result = runDocument(invalid);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /struct/);
  assert.match(result.output, /openapi\.json/);
});

test('core lint fails on malformed YAML', () => {
  const result = runDocument('openapi: [');
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /parse|YAML|end of the stream/i);
});

test('core lint fails when the input document is missing', () => {
  const result = spawnSync(
    process.execPath,
    [script, 'nonexistent-openapi.yaml'],
    { cwd: root, encoding: 'utf8' },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /nonexistent-openapi.yaml/);
});

test('core lint retains warning-only success semantics', () => {
  const warning = structuredClone(document);
  delete record(warning.info).license;
  const result = runDocument(warning);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /info-license/);
  assert.match(result.output, /1 warning\(s\)/);
});
