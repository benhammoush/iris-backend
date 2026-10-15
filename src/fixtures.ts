import { assetIdentity } from './transforms.ts';
import { SOL_MINT } from './constants.ts';

export const MARKET_SNAPSHOT_AS_OF = '2025-06-30T00:00:00.000Z';
function staticAsset(
  symbol: string,
  name: string,
  mint: string,
  decimals: number,
  totalSupply: number | null = null,
) {
  return {
    ...assetIdentity(mint),
    symbol,
    name,
    imageUrl: '',
    decimals,
    price: null,
    supply: null,
    totalSupply,
    marketCap: null,
    change24h: null,
    change7d: null,
    change30d: null,
    priceHistory: null,
    actualprice: null,
    image: '',
    marketcap: null,
    pricedayminusone: null,
    percentdayminusone: null,
    priceweekminusone: null,
    percentweekminusone: null,
    pricemonthminusone: null,
    percentmonthminusone: null,
    contractname: mint,
  };
}

export const MARKET_SNAPSHOT = Object.freeze({
  source: 'fixture',
  asOf: MARKET_SNAPSHOT_AS_OF,
  assets: [
    staticAsset('SOL', 'Solana', SOL_MINT, 9),
    staticAsset(
      'USDC',
      'USD Coin',
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      6,
    ),
    staticAsset(
      'JUP',
      'Jupiter',
      'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
      6,
    ),
  ],
});

export const FIXTURE_SNAPSHOT = {
  version: 1,
  createdAt: '1970-01-01T00:00:00.000Z',
  source: 'fixture',
  market: {
    fees: null,
    slot: null,
    block_height: null,
    source: MARKET_SNAPSHOT.source,
    asOf: MARKET_SNAPSHOT.asOf,
    history: [],
  },
  network: {
    source: 'fixture',
    fetchedAt: null,
    chain: { state: 'unavailable', asOf: null },
    performance: { state: 'unavailable', asOf: null },
    production: { state: 'unavailable', asOf: null },
    fees: { state: 'unavailable', asOf: null },
    validators: { state: 'unavailable', asOf: null },
    economics: { state: 'unavailable', asOf: null },
    reliability: { state: 'unavailable', asOf: null },
  },
  assets: MARKET_SNAPSHOT.assets,
  catalogs: { topTraded: MARKET_SNAPSHOT.assets, trending: [], recent: [] },
  wallets: {},
  swaps: [],
};
