/** Blocking source and docblock checks for handwritten application, tooling and test code.
 * @file
 */

import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import jsdoc from 'eslint-plugin-jsdoc';
import tsdoc from 'eslint-plugin-tsdoc';

// Named contracts are documented; anonymous callbacks and declarative tests are exempt.
const contexts = [
  'FunctionDeclaration',
  'FunctionExpression[parent.type="VariableDeclarator"]',
  'ArrowFunctionExpression[parent.type="VariableDeclarator"]',
  'FunctionExpression[id]',
  'MethodDefinition',
  'Property[value.type=/^(ArrowFunctionExpression|FunctionExpression)$/]',
  'PropertyDefinition[value.type=/^(ArrowFunctionExpression|FunctionExpression)$/]',
  'ClassDeclaration',
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
  'TSMethodSignature',
  'TSPropertySignature[typeAnnotation.typeAnnotation.type="TSFunctionType"]',
  'VariableDeclaration:not([parent.type="ExportNamedDeclaration"]):has(VariableDeclarator > CallExpression[callee.name=/^(memo|forwardRef)$/])',
  'VariableDeclaration:not([parent.type="ExportNamedDeclaration"]):has(VariableDeclarator > CallExpression[callee.object.name="React"][callee.property.name=/^(memo|forwardRef)$/])',
  'ExportNamedDeclaration:has(VariableDeclaration > VariableDeclarator > CallExpression[callee.name=/^(memo|forwardRef)$/])',
  'ExportNamedDeclaration:has(VariableDeclaration > VariableDeclarator > CallExpression[callee.object.name="React"][callee.property.name=/^(memo|forwardRef)$/])',
];

export default [
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    plugins: { jsdoc },
    settings: { jsdoc: { mode: 'typescript' } },
    rules: {
      'jsdoc/require-jsdoc': [
        'error',
        { contexts, exemptEmptyFunctions: false },
      ],
      'jsdoc/require-description': [
        'error',
        { contexts: ['any'], exemptedBy: [] },
      ],
      'jsdoc/check-tag-names': [
        'error',
        { definedTags: ['packageDocumentation'] },
      ],
      'jsdoc/check-param-names': 'error',
      'jsdoc/require-param-description': 'error',
      'jsdoc/require-returns-description': 'error',
      'jsdoc/valid-types': 'error',
      'jsdoc/require-file-overview': 'error',
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { tsdoc },
    rules: {
      'tsdoc/syntax': 'error',
      'jsdoc/no-types': 'error',
      'jsdoc/require-file-overview': [
        'error',
        {
          tags: {
            packageDocumentation: {
              initialCommentsOnly: true,
              mustExist: true,
              preventDuplicates: true,
            },
            file: { mustExist: false },
          },
        },
      ],
    },
  },
  { ignores: ['node_modules/**', 'dist/**', 'coverage/**', '.wrangler/**'] },
  {
    files: ['**/*.{js,mjs,ts,tsx}'],
    languageOptions: { parser: tseslint.parser, globals: globals.worker },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: ['**/*.ts'],
    rules: {
      'no-undef': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
    },
  },
  {
    files: ['*.mjs', 'scripts/**', 'tests/**'],
    languageOptions: { globals: globals.node },
  },
];
