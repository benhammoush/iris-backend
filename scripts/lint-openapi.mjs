/**
 * Validate the canonical OpenAPI document with the repository's blocking rules.
 * @file
 */

import {
  createConfig,
  formatProblems,
  getTotals,
  lint,
} from '@redocly/openapi-core';

// Match the former CLI's recommended policy and two explicit exceptions.
// Use core directly: the CLI also bundles an unused documentation renderer.
try {
  if (process.argv.length > 3)
    throw new Error('Usage: node scripts/lint-openapi.mjs [document]');
  const ref = process.argv[2] ?? 'openapi.yaml';
  const config = await createConfig({
    extends: ['recommended'],
    rules: {
      'operation-summary': 'off',
      'operation-4xx-response': 'off',
    },
  });
  const problems = await lint({ ref, config });
  const totals = getTotals(problems);
  formatProblems(problems, {
    totals,
    format: 'codeframe',
    color: false,
    command: 'lint',
  });
  console.error(
    `${ref}: ${totals.errors} error(s), ${totals.warnings} warning(s)`,
  );
  process.exitCode = totals.errors > 0 ? 1 : 0;
} catch (error) {
  console.error(`OpenAPI lint failed: ${error.message}`);
  process.exitCode = 1;
}
