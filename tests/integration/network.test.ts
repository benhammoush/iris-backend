import test from 'node:test';
import assert from 'node:assert/strict';
import { record } from '../../src/record.ts';
import {
  normalizeNetworkSnapshot,
  refreshNetworkMetrics,
  summarizePerformance,
  summarizeProduction,
  type Rpc,
} from '../../src/network.ts';

test('network summaries use weighted TPS and current-epoch aggregate production', () => {
  assert.deepEqual(
    summarizePerformance([
      { numTransactions: 100, numNonVoteTransactions: 80, samplePeriodSecs: 2 },
      { numTransactions: 150, numNonVoteTransactions: 90, samplePeriodSecs: 3 },
    ]),
    {
      tps: 50,
      nonVoteTps: 34,
      sampleCount: 2,
      samplePeriodSecs: 5,
      transactions: 250,
      nonVoteTransactions: 170,
    },
  );
  assert.deepEqual(
    summarizeProduction({
      value: {
        range: { firstSlot: 1, lastSlot: 5 },
        byIdentity: { one: [4, 3], two: [6, 5] },
      },
    }),
    {
      assignedLeaderSlots: 10,
      blocksProduced: 8,
      missedLeaderSlots: 2,
      productionPct: 80,
      range: { firstSlot: 1, lastSlot: 5 },
    },
  );
});

test('failed network groups retain prior values as stale without substituting zero', () => {
  const rejected = {
    status: 'rejected' as const,
    reason: new Error('unavailable'),
  };
  const snapshot = normalizeNetworkSnapshot(
    {
      slots: rejected,
      epoch: rejected,
      blockHeight: rejected,
      blockTime: rejected,
      performance: rejected,
      production: rejected,
      priorityFees: rejected,
      voteAccounts: rejected,
      supply: rejected,
      inflationRate: rejected,
      inflationGovernor: rejected,
      block: rejected,
    },
    {
      performance: {
        state: 'fresh',
        asOf: '2026-10-01T00:00:00.000Z',
        tps: 42,
      },
      chain: {
        state: 'fresh',
        asOf: '2026-10-01T00:00:00.000Z',
        finalizedSlot: 123,
      },
    },
    new Date('2026-10-02T00:00:00.000Z'),
  );
  assert.equal(snapshot.performance.state, 'stale');
  assert.equal(record(snapshot.performance).tps, 42);
  assert.equal(snapshot.chain.state, 'stale');
  assert.equal(snapshot.fees.state, 'unavailable');
});

test('network refresh uses the latest actual finalized block for average fees', async () => {
  const calls: [string, unknown[]][] = [];
  const rpc: Rpc = async (method, params) => {
    calls.push([method, params]);
    if (method === 'getSlot')
      return record(params[0]).commitment === 'finalized' ? 1000 : 1001;
    if (method === 'getBlockHeight') return 900;
    if (method === 'getEpochInfo')
      return {
        epoch: 1,
        slotIndex: 100,
        slotsInEpoch: 432000,
        absoluteSlot: 1000,
      };
    if (method === 'getRecentPerformanceSamples') return [];
    if (method === 'getRecentPrioritizationFees')
      return [{ prioritizationFee: 25 }];
    if (method === 'getVoteAccounts') return { current: [], delinquent: [] };
    if (method === 'getSupply') return { value: {} };
    if (method === 'getInflationRate') return {};
    if (method === 'getInflationGovernor') return {};
    if (method === 'getBlocksWithLimit') return [997, 999];
    if (method === 'getBlockTime') return 1;
    if (method === 'getBlockProduction') return { value: { byIdentity: {} } };
    if (method === 'getBlock')
      return {
        transactions: [
          { meta: { fee: 5000, err: null } },
          { meta: { fee: 7000, err: null } },
        ],
      };
    throw new Error(`Unexpected ${method}`);
  };
  const snapshot = await refreshNetworkMetrics(
    rpc,
    null,
    new Date('2026-10-06T00:00:00.000Z'),
  );
  assert.deepEqual(
    calls.find(([method]) => method === 'getBlock')?.[1]?.slice(0, 1),
    [999],
  );
  assert.equal(
    record(calls.find(([method]) => method === 'getBlock')?.[1]?.[1])
      .maxSupportedTransactionVersion,
    1,
  );
  assert.deepEqual(
    calls.find(([method]) => method === 'getInflationRate')?.[1],
    [],
  );
  assert.equal(record(snapshot.fees).averageFeeLamports, 6000);
  assert.equal(record(snapshot.fees).medianPriorityFeeMicroLamports, 25);
});

test('supply remains available when inflation data is unavailable', () => {
  const fulfilled = (value: unknown) => ({
    status: 'fulfilled' as const,
    value,
  });
  const rejected = {
    status: 'rejected' as const,
    reason: new Error('unavailable'),
  };
  const snapshot = normalizeNetworkSnapshot({
    slots: rejected,
    epoch: rejected,
    blockHeight: rejected,
    blockTime: rejected,
    performance: rejected,
    production: rejected,
    priorityFees: rejected,
    voteAccounts: rejected,
    supply: fulfilled({
      value: {
        total: 1_000_000_000,
        circulating: 800_000_000,
        nonCirculating: 200_000_000,
      },
    }),
    inflationRate: rejected,
    inflationGovernor: rejected,
    block: rejected,
  });
  assert.equal(snapshot.economics.state, 'fresh');
  assert.equal(record(snapshot.economics).totalSol, 1);
  assert.equal(record(snapshot.economics).circulatingSol, 0.8);
});

test('network refresh falls back to the finalized slot when the block list is empty', async () => {
  const calls: [string, unknown[]][] = [];
  const rpc: Rpc = async (method, params) => {
    calls.push([method, params]);
    if (method === 'getSlot') return 1000;
    if (method === 'getBlockHeight') return 900;
    if (method === 'getEpochInfo')
      return {
        epoch: 1,
        slotIndex: 100,
        slotsInEpoch: 432000,
        absoluteSlot: 1000,
      };
    if (
      method === 'getRecentPerformanceSamples' ||
      method === 'getRecentPrioritizationFees'
    )
      return [];
    if (method === 'getVoteAccounts') return { current: [], delinquent: [] };
    if (method === 'getSupply') return { value: {} };
    if (method === 'getInflationRate' || method === 'getInflationGovernor')
      return {};
    if (method === 'getBlocksWithLimit') return [];
    if (method === 'getBlockTime') return 1;
    if (method === 'getBlockProduction') return { value: { byIdentity: {} } };
    if (method === 'getBlock') return { transactions: [] };
    throw new Error(`Unexpected ${method}`);
  };
  await refreshNetworkMetrics(rpc);
  assert.deepEqual(
    calls.find(([method]) => method === 'getBlock')?.[1]?.slice(0, 1),
    [1000],
  );
});
