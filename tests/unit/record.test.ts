/**
 * Preserve scalar quantities and reject object coercion at untrusted boundaries.
 * @packageDocumentation
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { scalarText, errorMessage } from '../../src/record.ts';

void test('scalar conversion preserves exact strings and bigint quantities', () => {
  assert.equal(
    scalarText('9007199254740993123', 'invalid'),
    '9007199254740993123',
  );
  assert.equal(
    scalarText(9007199254740993123n, 'invalid'),
    '9007199254740993123',
  );
  assert.equal(scalarText(123, 'invalid'), '123');
});

void test('objects never invoke coercion or become fabricated zero quantities', () => {
  const object = {
    /** Reject any attempt to stringify untrusted objects.
     * @returns No text; accidental coercion fails this regression.
     */
    toString(): string {
      throw new Error('Unexpected object coercion');
    },
  };
  assert.equal(scalarText(object, 'invalid'), 'invalid');
  assert.equal(scalarText([], 'invalid'), 'invalid');
  assert.equal(errorMessage(object), 'Unknown failure');
  assert.equal(
    errorMessage(new Error('Controlled failure')),
    'Controlled failure',
  );
});
