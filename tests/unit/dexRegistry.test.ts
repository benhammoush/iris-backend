import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isRegisteredDexSwap,
  protocolForSwap,
  registeredDexRoutes,
} from '../../src/dexRegistry.ts';

test('tracked swap registration needs both the source and reviewed account evidence', () => {
  const route = registeredDexRoutes()[0];
  assert.ok(route);
  for (const account of [route.programId, ...route.pools]) {
    const transaction = {
      type: 'SWAP',
      source: route.source,
      accountData: [{ account }],
    };
    assert.equal(isRegisteredDexSwap(transaction), true);
    assert.equal(protocolForSwap(transaction), route.protocol);
    assert.equal(
      isRegisteredDexSwap({ ...transaction, type: 'TRANSFER' }),
      false,
    );
    assert.equal(
      isRegisteredDexSwap({ ...transaction, source: 'OTHER' }),
      false,
    );
  }
  for (const transaction of [
    null,
    [],
    {},
    {
      type: 'SWAP',
      source: route.source,
      accountData: [null, 42, { account: 'unknown' }],
    },
  ]) {
    assert.equal(isRegisteredDexSwap(transaction), false);
    assert.equal(protocolForSwap(transaction), null);
  }
});

test('callers cannot modify the registry through the returned pool list', () => {
  const route = registeredDexRoutes()[0];
  assert.ok(route);
  route.pools.push('unreviewed-pool');
  assert.equal(
    isRegisteredDexSwap({
      type: 'SWAP',
      source: route.source,
      accountData: [{ account: 'unreviewed-pool' }],
    }),
    false,
  );
});
