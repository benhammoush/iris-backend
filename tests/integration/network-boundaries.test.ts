/**
 * Regression coverage and controlled fixtures for network boundaries.
 * @packageDocumentation
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizePerformance,
  summarizeProduction,
  summarizeLatestBlock,
} from '../../src/network.ts';

void test('network summaries safely reject malformed samples and preserve weighted non-vote behavior', () => {
  const result = summarizePerformance([
    null,
    42,
    { numTransactions: 100, samplePeriodSecs: 10, numNonVoteTransactions: 50 },
    { numTransactions: 300, samplePeriodSecs: 30 },
  ]);
  assert.equal(result.tps, 10);
  assert.equal(result.nonVoteTps, null);
  assert.equal(result.sampleCount, 2);
  assert.equal(summarizePerformance(null).tps, null);
});

void test('block and production arithmetic use only finite provider quantities', () => {
  const production = summarizeProduction({
    value: { byIdentity: { a: [10, 8], b: [20, 16] } },
  });
  assert.equal(production.productionPct, 80);
  assert.equal(production.missedLeaderSlots, 6);
  const block = summarizeLatestBlock({
    parentSlot: 9,
    transactions: [
      null,
      { meta: { fee: 10, err: null } },
      { meta: { fee: 30, err: 'failed' } },
    ],
  });
  assert.equal(block.slot, 10);
  assert.equal(block.averageFeeLamports, 20);
  assert.equal(block.failedTransactions, 1);
  assert.equal(summarizeLatestBlock(null).failedTransactions, null);
});
