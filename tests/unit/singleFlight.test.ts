import test from 'node:test';
import assert from 'node:assert/strict';
import { singleFlight } from '../../src/singleFlight.ts';
import { deferred } from '../support/deferred.ts';

test('identical pending work is shared, but completed results are not cached', async () => {
  const scope = {};
  const gate = deferred<number>();
  let calls = 0;
  const work = () => {
    calls++;
    return gate.promise;
  };
  const first = singleFlight(scope, ['operation', 'mint'], work);
  const second = singleFlight(scope, ['operation', 'mint'], work);
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  gate.resolve(42);
  assert.deepEqual(await Promise.all([first, second]), [42, 42]);
  assert.equal(await singleFlight(scope, ['operation', 'mint'], work), 42);
  assert.equal(calls, 2);
});

test('scopes, typed keys, cursor delimiters and function identities stay separate', async () => {
  const scope = {};
  const gate = deferred<void>();
  const work = () => gate.promise;
  const first = singleFlight(scope, ['operation', null], work);
  const variants = [
    singleFlight({}, ['operation', null], work),
    singleFlight(scope, ['operation', 'initial'], work),
    singleFlight(scope, ['operation', undefined], work),
    singleFlight(scope, ['operation', 1], work),
    singleFlight(scope, ['operation', '1'], work),
    singleFlight(scope, ['operation:a', 'b'], work),
    singleFlight(scope, ['operation', 'a:b'], work),
    singleFlight(scope, ['operation', () => {}], work),
    singleFlight(scope, ['operation', () => {}], work),
  ];
  assert.equal(new Set([first, ...variants]).size, variants.length + 1);
  gate.resolve();
  await Promise.all([first, ...variants]);
});

test('asynchronous rejection and synchronous throw clear pending work for retry', async () => {
  const scope = {};
  const failure = new Error('failed');
  const gate = deferred<number>();
  const first = singleFlight(scope, ['operation'], () => gate.promise);
  const second = singleFlight(scope, ['operation'], () => gate.promise);
  const rejected = Promise.allSettled([first, second]);
  gate.reject(failure);
  for (const result of await rejected) {
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') assert.equal(result.reason, failure);
  }
  await assert.rejects(
    singleFlight(scope, ['operation'], () => {
      throw failure;
    }),
    /failed/,
  );
  assert.equal(await singleFlight(scope, ['operation'], async () => 7), 7);
});

test('unscoped work is not shared', async () => {
  let calls = 0;
  const work = async () => ++calls;
  assert.deepEqual(
    await Promise.all([
      singleFlight(null, ['operation'], work),
      singleFlight(undefined, ['operation'], work),
    ]),
    [1, 2],
  );
});
