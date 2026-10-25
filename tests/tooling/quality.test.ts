/**
 * Prove that unhandled application promises remain blocking in the real TS project.
 * @packageDocumentation
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ESLint } from 'eslint';

void test('typed lint rejects unhandled promises on a real project path', async () => {
  const [result] = await new ESLint().lintText(
    '/** Quality fixture.\n * @packageDocumentation\n */\nPromise.resolve(1);',
    { filePath: 'src/record.ts' },
  );
  assert.equal(result.fatalErrorCount, 0);
  assert.ok(
    result.messages.some(
      (message) => message.ruleId === '@typescript-eslint/no-floating-promises',
    ),
  );
});
