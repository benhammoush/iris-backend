import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import worker from '../../src/index.ts';
import { SOL_MINT } from '../../src/constants.ts';
import { mapV3Asset } from '../../src/market.ts';
import { mapDasWallet, mapV3Event } from '../../src/v3.ts';
import { record } from '../../src/record.ts';
import type { Env } from '../../src/env.ts';

const document: unknown = parse(
  await readFile(new URL('../../openapi.yaml', import.meta.url), 'utf8'),
);
const ajv = new Ajv2020({
  strict: false,
  allErrors: true,
  allowUnionTypes: true,
});
addFormats(ajv);
ajv.addSchema({
  $id: 'https://iris.test/contract',
  components: { schemas: record(record(document).components).schemas },
});

function validator(name: string) {
  return ajv.compile({
    $ref: `https://iris.test/contract#/components/schemas/${name}`,
  });
}

function envelope(data: unknown) {
  return { data, meta: { requestId: 'contract-test' } };
}

test('canonical fixture and unavailable responses match their declared envelopes', async () => {
  const env: Env = {
    PROVIDER_MODE: 'cache-only',
    SNAPSHOTS: { get: async () => null, put: async () => {} },
  };
  const cases = [
    ['/health', 'HealthEnvelope'],
    ['/ready', 'ReadyEnvelope'],
    ['/v3/status', 'StatusEnvelope'],
    ['/v3/network', 'NetworkEnvelope'],
    ['/v3/assets', 'AssetListEnvelope'],
    ['/v3/catalogs', 'CatalogsEnvelope'],
    ['/v3/defillama', 'DefiLlamaEnvelope'],
    ['/v3/swaps', 'SwapsEnvelope'],
    ['/v3/transactions/recent', 'RecentTransactionsEnvelope'],
    [`/v3/assets/mint/${SOL_MINT}?includeHistory=false`, 'AssetDetailEnvelope'],
    [`/v3/assets/mint/${SOL_MINT}/history`, 'HistoryEnvelope'],
    [`/v3/assets/mint/${SOL_MINT}/candles`, 'CandlesEnvelope'],
  ];
  for (const [path, schema] of cases) {
    const response = await worker.fetch(
      new Request(`https://iris.test${path}`),
      env,
    );
    assert.equal(response.status, 200, path);
    const body: unknown = await response.json();
    const validate = validator(schema);
    assert.ok(validate(body), `${path}: ${ajv.errorsText(validate.errors)}`);
  }
});

test('generated wallet/event and asset schemas retain atomic strings and nullable data', () => {
  const asset = mapV3Asset({
    id: SOL_MINT,
    symbol: 'SOL',
    name: 'Solana',
    decimals: 9,
  });
  const wallet = mapDasWallet(
    'wallet',
    { nativeBalance: { lamports: '9007199254740993123' }, items: [] },
    [asset],
  );
  const event = mapV3Event({
    signature: 'signature',
    parserStatus: 'OK',
    parsed: {
      transactionStatus: 'OK',
      summary: { type: 'transfer' },
      nativeTransfers: [
        {
          fromUserAccount: 'from',
          toUserAccount: 'to',
          amount: '9007199254740993123',
        },
      ],
    },
  });
  for (const [schema, body] of [
    ['AssetListEnvelope', envelope([asset])],
    ['WalletEnvelope', envelope(wallet)],
    ['TransactionsEnvelope', envelope({ events: [event], nextCursor: null })],
  ] satisfies [string, unknown][]) {
    const validate = validator(schema);
    assert.ok(validate(body), `${schema}: ${ajv.errorsText(validate.errors)}`);
  }
  assert.equal(wallet.balances[0]?.atomicAmount, '9007199254740993123');
  assert.equal(wallet.balances[0]?.priceUsd, null);
  const validate = validator('WalletEnvelope');
  const balance = wallet.balances[0];
  assert.ok(balance);
  assert.equal(
    validate(
      envelope({
        ...wallet,
        balances: [{ ...balance, atomicAmount: Number('9007199254740993123') }],
      }),
    ),
    false,
  );
  assert.equal(
    validate(envelope({ ...wallet, valuation: { holdingCount: 'invalid' } })),
    false,
  );
  assert.equal(
    validate(envelope({ address: 'wallet', balances: [], valuation: {} })),
    true,
  );
  assert.equal(
    validator('OnchainAssetEnvelope')(envelope({ mint: SOL_MINT })),
    true,
  );
});

test('canonical specialized responses do not fall back to an untyped data envelope', () => {
  for (const name of [
    'NetworkEnvelope',
    'DefiLlamaEnvelope',
    'OnchainAssetEnvelope',
    'HoldersEnvelope',
    'DistributionEnvelope',
    'AssetTransactionsEnvelope',
  ]) {
    assert.equal(validator(name)(envelope({})), false, name);
  }
});

test('fresh Helius profile, holder, distribution and transaction serializers match the contract', async (t) => {
  const account = {
    data: {
      parsed: { info: { owner: 'owner', state: 'initialized', decimals: 9 } },
    },
  };
  t.mock.method(
    globalThis,
    'fetch',
    async (_input: string | URL | Request, init?: RequestInit) => {
      const requestBody: unknown = JSON.parse(String(init?.body));
      const request = record(requestBody);
      if (!request.method)
        return Response.json({
          data: [
            {
              signature: 'signature',
              parsed: {
                slot: 10,
                blockTime: 1760000000,
                transactionStatus: 'OK',
                summary: { type: 'transfer' },
                tokenTransfers: [
                  {
                    mint: SOL_MINT,
                    rawTokenAmount: '9007199254740993123',
                    decimals: 9,
                    fromUserAccount: 'from',
                    toUserAccount: 'to',
                  },
                ],
              },
            },
          ],
          paginationToken: null,
        });
      const results: Record<string, unknown> = {
        getAsset: {
          id: SOL_MINT,
          token_info: { decimals: 9, supply: '9007199254740993123' },
        },
        getTokenSupply: { value: { amount: '9007199254740993123' } },
        getAccountInfo: { value: account },
        getTokenAccounts: {
          total: 1,
          token_accounts: [
            {
              address: 'account',
              owner: 'owner',
              amount: '9007199254740993123',
            },
          ],
        },
        getTokenLargestAccounts: {
          context: { slot: 10 },
          value: [
            { address: 'account', amount: '9007199254740993123', decimals: 9 },
          ],
        },
        getMultipleAccounts: { value: [account] },
      };
      assert.equal(typeof request.method, 'string');
      return Response.json({ result: results[String(request.method)] });
    },
  );
  const env: Env = {
    HELIUS_API_KEY: 'test-key',
    SNAPSHOTS: { get: async () => null, put: async () => {} },
  };
  for (const [suffix, schema] of [
    ['onchain', 'OnchainAssetEnvelope'],
    ['holders', 'HoldersEnvelope'],
    ['distribution', 'DistributionEnvelope'],
    ['transactions', 'AssetTransactionsEnvelope'],
  ]) {
    const response = await worker.fetch(
      new Request(`https://iris.test/v3/assets/mint/${SOL_MINT}/${suffix}`),
      env,
    );
    assert.equal(response.status, 200, suffix);
    const body: unknown = await response.json();
    const validate = validator(schema);
    assert.ok(validate(body), `${suffix}: ${ajv.errorsText(validate.errors)}`);
  }
});
