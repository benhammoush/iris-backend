/** Package the selected target without provider credentials or deployment. @file */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

assert.ok(['dev', 'production'].includes(process.env.CI_ENVIRONMENT));
execFileSync(
  process.execPath,
  [
    'node_modules/wrangler/bin/wrangler.js',
    'deploy',
    '--dry-run',
    '--env',
    process.env.CI_ENVIRONMENT,
    '--outdir',
    'dist',
  ],
  { stdio: 'inherit' },
);
