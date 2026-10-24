/**
 * Reject package, lockfile and runtime version identity drift.
 * @file
 */

import { readFile } from 'node:fs/promises';

const packageJson = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url)),
);
const constants = await readFile(
  new URL('../src/constants.ts', import.meta.url),
  'utf8',
);
const openapi = await readFile(
  new URL('../openapi.yaml', import.meta.url),
  'utf8',
);
const runtimeVersion = constants.match(/API_VERSION = '([^']+)'/)?.[1];
const contractVersion = openapi.match(/^ {2}version: ([^\s]+)$/m)?.[1];

if (
  !runtimeVersion ||
  !contractVersion ||
  packageJson.version !== runtimeVersion ||
  packageJson.version !== contractVersion
) {
  throw new Error(
    `Version mismatch: package=${packageJson.version}, runtime=${runtimeVersion ?? 'missing'}, OpenAPI=${contractVersion ?? 'missing'}`,
  );
}
