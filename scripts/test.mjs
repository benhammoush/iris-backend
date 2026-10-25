/**
 * Discover Worker tests recursively and run them with the TypeScript loader.
 * @file
 */

import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Discover test files recursively and return stable filesystem paths for the test runner.
 * @param directory - Test directory URL to inspect recursively.
 * @returns Files matching the supported test extensions under that directory.
 */
async function discover(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      files.push(...(await discover(new URL(`${entry.name}/`, directory))));
    } else if (entry.isFile() && /\.test\.(?:js|ts)$/.test(entry.name)) {
      files.push(fileURLToPath(new URL(entry.name, directory)));
    }
  }
  return files;
}

const files = (await discover(new URL('../tests/', import.meta.url))).sort();
if (!files.length) throw new Error('No Worker tests were discovered.');

// Explicit discovery includes both languages throughout the migration on Node 22.
const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', ...process.argv.slice(2), ...files],
  {
    stdio: 'inherit',
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
