import { array, record } from './record.ts';
import { unavailable } from './diagnostics.ts';

export type Rpc = (
  method: string,
  params: unknown[],
  timeoutMs?: number,
) => Promise<unknown>;
interface Outcome {
  status: 'fulfilled' | 'rejected';
  value?: unknown;
  reason?: unknown;
}
type NetworkResults = Record<
  | 'slots'
  | 'epoch'
  | 'blockHeight'
  | 'blockTime'
  | 'performance'
  | 'production'
  | 'priorityFees'
  | 'voteAccounts'
  | 'supply'
  | 'inflationRate'
  | 'inflationGovernor'
  | 'block',
  Outcome
>;
const LAMPORTS_PER_SOL = 1_000_000_000;

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function median(values: number[]) {
  const sorted = values
    .filter((value) => finite(value) !== null)
    .sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function staleOrUnavailable(previous: unknown, key: string) {
  const prior = record(previous)[key];
  return prior && record(prior).state !== 'unavailable'
    ? { ...record(prior), state: 'stale' }
    : { state: 'unavailable', asOf: null };
}

export function staleDashboardNetwork(previous: unknown = null) {
  return {
    source: 'helius-rpc',
    fetchedAt: record(previous).fetchedAt ?? null,
    chain: staleOrUnavailable(previous, 'chain'),
    performance: staleOrUnavailable(previous, 'performance'),
    fees: staleOrUnavailable(previous, 'fees'),
  };
}

function fulfilled(result: Outcome): unknown {
  return result.status === 'fulfilled' ? result.value : null;
}

function logRejectedRpcCalls(methods: string[], results: Outcome[]) {
  results.forEach((result, index) => {
    if (result.status === 'rejected')
      unavailable(
        'network-rpc',
        'Helius',
        result.reason,
        undefined,
        methods[index],
      );
  });
}

export function summarizePerformance(samples: unknown) {
  const usable = array(samples)
    .map((sample) => ({
      numTransactions: finite(record(sample).numTransactions),
      samplePeriodSecs: finite(record(sample).samplePeriodSecs),
      numNonVoteTransactions: finite(record(sample).numNonVoteTransactions),
    }))
    .filter(
      (sample) =>
        finite(sample?.numTransactions) !== null &&
        finite(sample?.samplePeriodSecs) !== null &&
        (sample.samplePeriodSecs ?? 0) > 0,
    );
  const seconds = usable.reduce(
    (total, sample) => total + (sample.samplePeriodSecs ?? 0),
    0,
  );
  const transactions = usable.reduce(
    (total, sample) => total + (sample.numTransactions ?? 0),
    0,
  );
  const hasNonVote =
    usable.length > 0 &&
    usable.every((sample) => finite(sample.numNonVoteTransactions) !== null);
  const nonVoteTransactions = hasNonVote
    ? usable.reduce(
        (total, sample) => total + (sample.numNonVoteTransactions ?? 0),
        0,
      )
    : null;
  return {
    tps: seconds ? transactions / seconds : null,
    nonVoteTps:
      seconds && nonVoteTransactions !== null
        ? nonVoteTransactions / seconds
        : null,
    sampleCount: usable.length,
    samplePeriodSecs: seconds,
    transactions,
    nonVoteTransactions,
  };
}

export function summarizeProduction(production: unknown) {
  const value = record(record(production).value);
  const entries = Object.values(record(value.byIdentity));
  const totals = entries.reduce<{ assigned: number; produced: number }>(
    (current, value) => ({
      assigned: current.assigned + (finite(array(value)[0]) || 0),
      produced: current.produced + (finite(array(value)[1]) || 0),
    }),
    { assigned: 0, produced: 0 },
  );
  return {
    assignedLeaderSlots: totals.assigned,
    blocksProduced: totals.produced,
    missedLeaderSlots: totals.assigned - totals.produced,
    productionPct: totals.assigned
      ? (totals.produced / totals.assigned) * 100
      : null,
    range: value.range || null,
  };
}

export function summarizeLatestBlock(block: unknown) {
  const data = record(block);
  const transactions = array(data.transactions);
  const fees = transactions
    .map((transaction) => finite(record(record(transaction).meta).fee))
    .filter((value): value is number => value !== null && value >= 0);
  const failedTransactions = transactions.filter(
    (transaction) => record(record(transaction).meta).err != null,
  ).length;
  return {
    available: Boolean(block),
    slot:
      finite(data.parentSlot) === null
        ? null
        : (finite(data.parentSlot) ?? 0) + 1,
    blockHeight: finite(data.blockHeight),
    blockTime: finite(data.blockTime),
    transactionCount: transactions.length,
    failedTransactions: block ? failedTransactions : null,
    failurePct:
      block && transactions.length
        ? (failedTransactions / transactions.length) * 100
        : null,
    averageFeeLamports: fees.length
      ? fees.reduce((total, fee) => total + fee, 0) / fees.length
      : null,
    feeSampleCount: fees.length,
  };
}

export function normalizeNetworkSnapshot(
  results: NetworkResults,
  previous: unknown = null,
  now = new Date(),
) {
  const asOf = now.toISOString();
  const slotsValue = fulfilled(results.slots);
  const epochValue = fulfilled(results.epoch);
  const slots = record(slotsValue);
  const epoch = record(epochValue);
  const blockHeight = fulfilled(results.blockHeight);
  const blockTime = fulfilled(results.blockTime);
  const performanceSamples = fulfilled(results.performance);
  const production = fulfilled(results.production);
  const priorityFees = fulfilled(results.priorityFees);
  const voteAccountsValue = fulfilled(results.voteAccounts);
  const voteAccounts = record(voteAccountsValue);
  const supplyValue = fulfilled(results.supply);
  const supply = record(record(supplyValue).value);
  const inflationRate = record(fulfilled(results.inflationRate));
  const inflationGovernor = fulfilled(results.inflationGovernor);
  const block = fulfilled(results.block);
  const chain =
    slotsValue && epochValue && blockHeight !== null
      ? {
          state: 'fresh',
          asOf,
          commitment: 'finalized',
          processedSlot: finite(slots.processed),
          confirmedSlot: finite(slots.confirmed),
          finalizedSlot: finite(slots.finalized),
          blockHeight: finite(blockHeight),
          blockTime: finite(blockTime),
          epoch: finite(epoch.epoch),
          slotIndex: finite(epoch.slotIndex),
          slotsInEpoch: finite(epoch.slotsInEpoch),
          epochProgressPct:
            finite(epoch.slotIndex) !== null &&
            (finite(epoch.slotsInEpoch) ?? 0) > 0
              ? ((finite(epoch.slotIndex) ?? 0) /
                  (finite(epoch.slotsInEpoch) ?? 1)) *
                100
              : null,
        }
      : staleOrUnavailable(previous, 'chain');
  const performance = performanceSamples
    ? { state: 'fresh', asOf, ...summarizePerformance(performanceSamples) }
    : staleOrUnavailable(previous, 'performance');
  const productionSummary = production
    ? { state: 'fresh', asOf, ...summarizeProduction(production) }
    : staleOrUnavailable(previous, 'production');
  const priorityFeeValues = Array.isArray(priorityFees)
    ? array(priorityFees)
        .map((sample) => finite(record(sample).prioritizationFee))
        .filter((value): value is number => value !== null && value >= 0)
    : null;
  const blockSummary = block ? summarizeLatestBlock(block) : null;
  const fees =
    priorityFeeValues !== null || blockSummary
      ? {
          state: 'fresh',
          asOf,
          averageFeeLamports: blockSummary?.averageFeeLamports ?? null,
          feeSampleCount: blockSummary?.feeSampleCount ?? 0,
          medianPriorityFeeMicroLamports: priorityFeeValues
            ? median(priorityFeeValues)
            : null,
          priorityFeeSampleCount: priorityFeeValues?.length ?? 0,
        }
      : staleOrUnavailable(previous, 'fees');
  const validators = voteAccountsValue
    ? {
        state: 'fresh',
        asOf,
        currentVoteAccounts: Array.isArray(voteAccounts.current)
          ? voteAccounts.current.length
          : 0,
        delinquentVoteAccounts: Array.isArray(voteAccounts.delinquent)
          ? voteAccounts.delinquent.length
          : 0,
      }
    : staleOrUnavailable(previous, 'validators');
  const economics = supplyValue
    ? {
        state: 'fresh',
        asOf,
        totalSol:
          finite(supply.total) === null
            ? null
            : (finite(supply.total) ?? 0) / LAMPORTS_PER_SOL,
        circulatingSol:
          finite(supply.circulating) === null
            ? null
            : (finite(supply.circulating) ?? 0) / LAMPORTS_PER_SOL,
        nonCirculatingSol:
          finite(supply.nonCirculating) === null
            ? null
            : (finite(supply.nonCirculating) ?? 0) / LAMPORTS_PER_SOL,
        inflationTotalPct:
          finite(inflationRate?.total) === null
            ? null
            : (finite(inflationRate.total) ?? 0) * 100,
        inflationValidatorPct:
          finite(inflationRate?.validator) === null
            ? null
            : (finite(inflationRate.validator) ?? 0) * 100,
        inflationFoundationPct:
          finite(inflationRate?.foundation) === null
            ? null
            : (finite(inflationRate.foundation) ?? 0) * 100,
        inflationEpoch: finite(inflationRate?.epoch),
        inflationGovernor: inflationGovernor || null,
      }
    : staleOrUnavailable(previous, 'economics');
  const reliability = blockSummary
    ? {
        state: 'fresh',
        asOf,
        available: blockSummary.available,
        finalizedSlot: slotsValue ? finite(slots.finalized) : null,
        blockHeight: blockSummary.blockHeight,
        blockTime: blockSummary.blockTime,
        transactionCount: blockSummary.transactionCount,
        failedTransactions: blockSummary.failedTransactions,
        failurePct: blockSummary.failurePct,
      }
    : staleOrUnavailable(previous, 'reliability');
  return {
    source: 'helius-rpc',
    fetchedAt: asOf,
    chain,
    performance,
    production: productionSummary,
    fees,
    validators,
    economics,
    reliability,
  };
}

export async function refreshNetworkMetrics(
  rpc: Rpc,
  previous: unknown = null,
  now = new Date(),
) {
  const initialMethods = [
    'getSlot:processed',
    'getSlot:confirmed',
    'getSlot:finalized',
    'getBlockHeight',
    'getEpochInfo',
    'getRecentPerformanceSamples',
    'getRecentPrioritizationFees',
    'getVoteAccounts',
    'getSupply',
    'getInflationRate',
    'getInflationGovernor',
  ];
  const initial = await Promise.allSettled([
    rpc('getSlot', [{ commitment: 'processed' }]),
    rpc('getSlot', [{ commitment: 'confirmed' }]),
    rpc('getSlot', [{ commitment: 'finalized' }]),
    rpc('getBlockHeight', [{ commitment: 'finalized' }]),
    rpc('getEpochInfo', [{ commitment: 'finalized' }]),
    rpc('getRecentPerformanceSamples', [5]),
    rpc('getRecentPrioritizationFees', []),
    rpc('getVoteAccounts', [{ commitment: 'finalized' }]),
    rpc(
      'getSupply',
      [{ commitment: 'finalized', excludeNonCirculatingAccountsList: true }],
      20_000,
    ),
    rpc('getInflationRate', []),
    rpc('getInflationGovernor', [{ commitment: 'finalized' }]),
  ]);
  logRejectedRpcCalls(initialMethods, initial);
  const [
    processed,
    confirmed,
    finalized,
    blockHeight,
    epoch,
    performance,
    priorityFees,
    voteAccounts,
    supply,
    inflationRate,
    inflationGovernor,
  ] = initial;
  const finalizedSlot = finite(fulfilled(finalized));
  const epochValue = fulfilled(epoch);
  const epochInfo = record(epochValue);
  const blockSlotsResult: Outcome =
    finalizedSlot === null
      ? { status: 'rejected', reason: new Error('Finalized slot unavailable') }
      : await Promise.allSettled([
          rpc('getBlocksWithLimit', [
            Math.max(0, finalizedSlot - 500),
            500,
            { commitment: 'finalized' },
          ]),
        ]).then(([result]) => result);
  const blockSlots = fulfilled(blockSlotsResult);
  const latestBlockSlot =
    Array.isArray(blockSlots) && blockSlots.length
      ? finite(array(blockSlots)[blockSlots.length - 1])
      : null;
  if (blockSlotsResult.status === 'rejected')
    unavailable(
      'network-rpc',
      'Helius',
      blockSlotsResult.reason,
      undefined,
      'getBlocksWithLimit',
    );
  else if (latestBlockSlot === null)
    unavailable(
      'network-rpc',
      'Helius',
      undefined,
      undefined,
      'getBlocksWithLimit',
    );
  const dependent = await Promise.allSettled([
    finalizedSlot === null
      ? Promise.reject(new Error('Finalized slot unavailable'))
      : rpc('getBlockTime', [finalizedSlot]),
    finalizedSlot === null || !epochValue
      ? Promise.reject(new Error('Epoch range unavailable'))
      : rpc('getBlockProduction', [
          {
            commitment: 'finalized',
            range: {
              firstSlot:
                Number(epochInfo.absoluteSlot) - Number(epochInfo.slotIndex),
              lastSlot: finalizedSlot,
            },
          },
        ]),
    finalizedSlot === null
      ? Promise.reject(new Error('Finalized slot unavailable'))
      : rpc('getBlock', [
          latestBlockSlot ?? finalizedSlot,
          {
            commitment: 'finalized',
            transactionDetails: 'full',
            rewards: false,
            maxSupportedTransactionVersion: 1,
          },
        ]),
  ]);
  logRejectedRpcCalls(
    ['getBlockTime', 'getBlockProduction', 'getBlock'],
    dependent,
  );
  const [blockTime, production, block] = dependent;
  return normalizeNetworkSnapshot(
    {
      slots: {
        status:
          processed.status === 'fulfilled' &&
          confirmed.status === 'fulfilled' &&
          finalized.status === 'fulfilled'
            ? 'fulfilled'
            : 'rejected',
        value: {
          processed: fulfilled(processed),
          confirmed: fulfilled(confirmed),
          finalized: finalizedSlot,
        },
      },
      blockHeight,
      epoch,
      performance,
      priorityFees,
      voteAccounts,
      supply,
      inflationRate,
      inflationGovernor,
      blockTime,
      production,
      block,
    },
    previous,
    now,
  );
}

export async function refreshDashboardNetworkMetrics(
  rpc: Rpc,
  confirmedSlot: unknown,
  previous: unknown = null,
  now = new Date(),
) {
  const asOf = now.toISOString();
  const initial = await Promise.allSettled([
    rpc('getSlot', [{ commitment: 'processed' }]),
    rpc('getSlot', [{ commitment: 'finalized' }]),
    rpc('getBlockHeight', [{ commitment: 'finalized' }]),
    rpc('getEpochInfo', [{ commitment: 'finalized' }]),
    rpc('getRecentPerformanceSamples', [5]),
  ]);
  logRejectedRpcCalls(
    [
      'getSlot:processed',
      'getSlot:finalized',
      'getBlockHeight',
      'getEpochInfo',
      'getRecentPerformanceSamples',
    ],
    initial,
  );
  const [processed, finalized, blockHeight, epoch, performanceSamples] =
    initial;
  const finalizedSlot = finite(fulfilled(finalized));
  const blockSlotsResult: Outcome =
    finalizedSlot === null
      ? { status: 'rejected', reason: new Error('Finalized slot unavailable') }
      : await Promise.allSettled([
          rpc('getBlocksWithLimit', [
            Math.max(0, finalizedSlot - 500),
            500,
            { commitment: 'finalized' },
          ]),
        ]).then(([result]) => result);
  const blockSlots = fulfilled(blockSlotsResult);
  const latestBlockSlot =
    Array.isArray(blockSlots) && blockSlots.length
      ? blockSlots[blockSlots.length - 1]
      : null;
  if (blockSlotsResult.status === 'rejected')
    unavailable(
      'network-rpc',
      'Helius',
      blockSlotsResult.reason,
      undefined,
      'getBlocksWithLimit',
    );
  else if (latestBlockSlot === null)
    unavailable(
      'network-rpc',
      'Helius',
      undefined,
      undefined,
      'getBlocksWithLimit',
    );
  const blockResult: Outcome =
    finalizedSlot === null
      ? { status: 'rejected', reason: new Error('Finalized slot unavailable') }
      : await Promise.allSettled([
          rpc('getBlock', [
            latestBlockSlot ?? finalizedSlot,
            {
              commitment: 'finalized',
              transactionDetails: 'full',
              rewards: false,
              maxSupportedTransactionVersion: 1,
            },
          ]),
        ]).then(([result]) => result);
  if (blockResult.status === 'rejected')
    unavailable(
      'network-rpc',
      'Helius',
      blockResult.reason,
      undefined,
      'getBlock',
    );
  const chain =
    fulfilled(processed) !== null &&
    typeof confirmedSlot === 'number' &&
    Number.isInteger(confirmedSlot) &&
    confirmedSlot >= 0 &&
    finalizedSlot !== null &&
    fulfilled(blockHeight) !== null &&
    fulfilled(epoch)
      ? {
          state: 'fresh',
          asOf,
          commitment: 'finalized',
          processedSlot: finite(fulfilled(processed)),
          confirmedSlot: finite(confirmedSlot),
          finalizedSlot: finite(finalizedSlot),
          blockHeight: finite(fulfilled(blockHeight)),
          epoch: finite(record(fulfilled(epoch)).epoch),
        }
      : staleOrUnavailable(previous, 'chain');
  const performance = fulfilled(performanceSamples)
    ? {
        state: 'fresh',
        asOf,
        ...summarizePerformance(fulfilled(performanceSamples)),
      }
    : staleOrUnavailable(previous, 'performance');
  const block = fulfilled(blockResult);
  const blockSummary = block ? summarizeLatestBlock(block) : null;
  const fees = blockSummary
    ? {
        state: 'fresh',
        asOf,
        averageFeeLamports: blockSummary.averageFeeLamports,
        feeSampleCount: blockSummary.feeSampleCount,
      }
    : staleOrUnavailable(previous, 'fees');
  return { source: 'helius-rpc', fetchedAt: asOf, chain, performance, fees };
}
