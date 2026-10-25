/**
 * Exercise the real blocking docblock configuration on in-memory source.
 * @packageDocumentation
 */

import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';

// Only virtual documentation fixtures lack a TS project entry.
const eslint = new ESLint({
  overrideConfig: [
    { files: ['**/*.{ts,tsx}'], ...tseslint.configs.disableTypeChecked },
  ],
});
const header =
  '/** Fixture module.\n * @packageDocumentation\n */\nimport "fixture";\n';
// Cold parser/plugin loading belongs to bounded setup, not the per-fixture assertion budget.
before(
  async () => {
    await eslint.lintText(header, { filePath: 'src/documentation-fixture.ts' });
  },
  { timeout: 30_000 },
);
/** Collect only documentation failures, leaving unrelated fixture lint outside this assertion.
 * @param source - In-memory source whose documentation is under test.
 * @param filePath - Virtual path selecting the actual JS or TS rules.
 * @returns Documentation-rule identifiers, rejecting parser/ignored-file failures.
 */
async function errors(
  source: string,
  filePath = 'src/documentation-fixture.ts',
) {
  const [result] = await eslint.lintText(source, { filePath });
  assert.equal(result.fatalErrorCount, 0);
  assert.deepEqual(
    result.messages.filter((message) => message.ruleId === null),
    [],
  );
  return result.messages
    .filter((message) => /^(jsdoc\/|tsdoc\/)/.test(message.ruleId ?? ''))
    .map((message) => message.ruleId);
}

for (const source of [
  'function helper() { return 1; }',
  'const helper = () => 1;',
  'const Component = () => null;',
  'function useResource() { return null; }',
  'class Resource {}',
  'interface Contract { value: string }',
  'type Identity = string;',
  '/** Client boundary. */ interface Client { read(): string }',
  '/** Client boundary. */ interface Client { read: () => string }',
  'const client = { read: () => "value" };',
  'const Component = memo(() => null);',
  'const Component = React.forwardRef(() => null);',
]) {
  void test(`rejects an undocumented named contract: ${source}`, async () => {
    assert.ok((await errors(header + source)).includes('jsdoc/require-jsdoc'));
  });
}

void test('rejects malformed or ignored lint fixtures instead of silently passing', async () => {
  await assert.rejects(() => errors('export const broken = ;'));
  await assert.rejects(() =>
    errors('export {};', 'dist/documentation-fixture.ts'),
  );
});

void test('requires a separate module overview and function description', async () => {
  assert.ok(
    (
      await errors('/** Read the fixture. */ function read() { return 1; }')
    ).includes('jsdoc/require-file-overview'),
  );
  assert.ok(
    (await errors(header + '/** */ function read() { return 1; }')).includes(
      'jsdoc/require-description',
    ),
  );
});

void test('requires the TypeScript package overview to be initial and unique', async () => {
  assert.ok(
    (
      await errors(
        'const before = 1;\n/** Fixture module.\n * @packageDocumentation\n */\nexport {};',
      )
    ).includes('jsdoc/require-file-overview'),
  );
  assert.ok(
    (
      await errors(
        '/** First overview.\n * @packageDocumentation\n */\n/** Second overview.\n * @packageDocumentation\n */\nimport "fixture";',
      )
    ).includes('jsdoc/require-file-overview'),
  );
});

void test('accepts documented contracts and exempts ordinary anonymous callbacks', async () => {
  for (const wrapper of [
    'memo',
    'React.memo',
    'forwardRef',
    'React.forwardRef',
  ]) {
    assert.deepEqual(
      await errors(
        header +
          `/** Render fixture. */ export const Component = ${wrapper}(/** Render the fixture.\n * @returns The empty fixture view. */ () => null);`,
      ),
      [],
    );
    assert.ok(
      (
        await errors(
          header + `export const Component = ${wrapper}(() => null);`,
        )
      ).includes('jsdoc/require-jsdoc'),
    );
  }
  assert.deepEqual(
    await errors(
      header +
        '/** Read the fixture identity.\n * @returns The fixture identity. */ const read = () => "id";',
    ),
    [],
  );
  assert.deepEqual(
    await errors(
      header + '[1, 2].map((value) => value * 2); test("case", () => {});',
    ),
    [],
  );
});

void test('checks supplied parameter names, descriptions and return descriptions', async () => {
  assert.ok(
    (
      await errors(
        header +
          '/** Read identity.\n * @param wrong - Identity.\n */ function read(value: string) { return value; }',
      )
    ).includes('jsdoc/check-param-names'),
  );
  const missing = await errors(
    header +
      '/** Read identity.\n * @param value\n * @returns\n */ function read(value: string) { return value; }',
  );
  assert.ok(missing.includes('jsdoc/require-param-description'));
  assert.ok(missing.includes('jsdoc/require-returns-description'));
});

void test('requires parameter and result tags on callable contracts', async () => {
  for (const signature of [
    'read(value: string): string;',
    'read: (value: string) => string;',
  ]) {
    const failures = await errors(
      header +
        `/** Fixture contract. */ interface Fixture { /** Read identity. */ ${signature} }`,
    );
    assert.ok(failures.includes('jsdoc/require-param'));
    assert.ok(failures.includes('jsdoc/require-returns'));
  }
  assert.deepEqual(
    await errors(
      header +
        '/** Fixture contract. */ interface Fixture { /** Clear fixture state. */ clear(): void; }',
    ),
    [],
  );
});

void test('rejects malformed TSDoc and duplicated TypeScript types', async () => {
  assert.ok(
    (
      await errors(
        header +
          '/** Read identity.\n * @notAStandardTag\n */ function read() { return 1; }',
      )
    ).includes('tsdoc/syntax'),
  );
  assert.ok(
    (
      await errors(
        header +
          '/** Read identity.\n * @param {string} value - Identity.\n */ function read(value: string) { return value; }',
      )
    ).includes('jsdoc/no-types'),
  );
});

void test('parses typed TSX before applying documentation rules', async () => {
  const filePath = 'src/documentation-fixture.tsx';
  const [result] = await eslint.lintText(
    header +
      '/** Heading properties. */ interface Props { label: string; timer?: NodeJS.Timeout }\n/** Render fixture.\n * @param props - Heading properties.\n * @returns The fixture heading. */ export const Component = (props: Props) => <div>{props.label}</div>;',
    { filePath },
  );
  assert.equal(result.fatalErrorCount, 0);
  assert.deepEqual(result.messages, []);
  assert.ok(
    (
      await errors(
        header +
          'export const Component = (props: { label: string; timer?: NodeJS.Timeout }) => <div>{props.label}</div>;',
        filePath,
      )
    ).includes('jsdoc/require-jsdoc'),
  );
});

void test('requires JavaScript module and named-helper documentation', async () => {
  const missing = await errors(
    'const read = () => "id";',
    'scripts/documentation-fixture.mjs',
  );
  assert.ok(missing.includes('jsdoc/require-file-overview'));
  assert.ok(missing.includes('jsdoc/require-jsdoc'));
  assert.deepEqual(
    await errors(
      '/** Fixture tooling.\n * @file\n */\nimport "fixture";\n/** Read fixture identity.\n * @returns The fixture identity. */ const read = () => "id";',
      'scripts/documentation-fixture.mjs',
    ),
    [],
  );
});

void test('excludes generated Worker output without excluding handwritten tests', async () => {
  assert.equal(
    await eslint.isPathIgnored('.wrangler/documentation-fixture.ts'),
    true,
  );
  assert.ok(
    (
      await errors(
        header + 'const helper = () => 1;',
        'tests/unit/documentation-fixture.test.ts',
      )
    ).includes('jsdoc/require-jsdoc'),
  );
});
