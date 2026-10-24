import test from 'node:test';
import assert from 'node:assert/strict';
import { SOL_MINT } from '../../src/constants.ts';
import {
  assetIdentity,
  addAtomicAmounts,
  decimalValue,
  formatAtomicAmount,
  isBase58PublicKey,
} from '../../src/transforms.ts';

test('Solana public keys require a Base58-encoded 32-byte value', () => {
  assert.equal(isBase58PublicKey(SOL_MINT), true);
  assert.equal(isBase58PublicKey('not-a-public-key'), false);
  assert.equal(isBase58PublicKey('0'.repeat(32)), false);
});

test('atomic token amounts remain strings and format without Number conversion', () => {
  assert.equal(
    formatAtomicAmount('9007199254740993123', 6),
    '9007199254740.993123',
  );
  assert.equal(formatAtomicAmount('1000000000', 9), '1');
  assert.equal(decimalValue('9007199254740.993123'), null);
  assert.equal(decimalValue('2.5'), 2.5);
  assert.deepEqual(assetIdentity(SOL_MINT), {
    chain: 'solana',
    assetId: SOL_MINT,
    mint: SOL_MINT,
    contractId: SOL_MINT,
    isNative: true,
  });
});

test('atomic helpers reject invalid values without substituting zero', () => {
  for (const decimals of [null, undefined, '9', -1, 1.5, Infinity]) {
    assert.equal(formatAtomicAmount('1000000000', decimals), null);
  }
  assert.equal(formatAtomicAmount('not-atomic', 9), null);
  assert.equal(formatAtomicAmount(1000000000, 9), null);
  assert.equal(decimalValue(null), null);
});

test('atomic addition preserves exact integers and reports invalid inputs', () => {
  const amounts = ['9007199254740993123', '7'];
  assert.equal(
    addAtomicAmounts(amounts),
    amounts.reduce((sum, amount) => sum + BigInt(amount), 0n).toString(),
  );
  assert.equal(addAtomicAmounts(['invalid']), null);
});
