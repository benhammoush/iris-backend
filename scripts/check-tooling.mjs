import assert from 'node:assert/strict';
import { ESLint } from 'eslint';
import { check, resolveConfig } from 'prettier';
import { readdir } from 'node:fs/promises';

async function assertTypeScriptOnly(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = new URL(
      entry.isDirectory() ? `${entry.name}/` : entry.name,
      directory,
    );
    if (entry.isDirectory()) await assertTypeScriptOnly(path);
    else
      assert.ok(
        !/\.(?:js|jsx|mjs|cjs)$/.test(entry.name),
        `Application JavaScript is not allowed: ${path.pathname}`,
      );
  }
}
await assertTypeScriptOnly(new URL('../src/', import.meta.url));
await assertTypeScriptOnly(new URL('../test/', import.meta.url));

const eslint = new ESLint();
const strictProbe = await eslint.lintText('export const unchecked: any = 1;', {
  filePath: 'src/tooling-probe.ts',
});
assert.ok(
  strictProbe[0].messages.some(
    (message) => message.ruleId === '@typescript-eslint/no-explicit-any',
  ),
  'Explicit any must fail TypeScript linting',
);
const [result] = await eslint.lintText(
  'export function example() { return undeclaredValue; }',
  { filePath: 'src/tooling-probe.js' },
);
assert.ok(
  result.messages.some((message) => message.ruleId === 'no-undef'),
  'Undeclared JavaScript identifiers must fail linting',
);
const options = await resolveConfig('src/tooling-probe.ts');
assert.equal(
  await check('export const example={value:1}', {
    ...options,
    parser: 'typescript',
  }),
  false,
  'Unformatted TypeScript must fail the format check',
);
console.log(
  'Tooling guards reject application JavaScript, explicit any, undeclared names and unformatted TypeScript.',
);
