import type { WorkerVariables } from './env.ts';

export interface WorkerConfig {
  corsOrigins: string[];
  heliusApiKey: string;
  jupiterApiKey: string;
  birdeyeApiKey: string;
  providerMode: 'cache-only' | 'live';
}

export type ProviderConfig = Partial<
  Pick<
    WorkerConfig,
    'heliusApiKey' | 'jupiterApiKey' | 'birdeyeApiKey' | 'providerMode'
  >
>;

export function getConfig(env: WorkerVariables): WorkerConfig {
  return {
    corsOrigins: (env.CORS_ORIGINS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    heliusApiKey: env.HELIUS_API_KEY || '',
    jupiterApiKey: env.JUPITER_API_KEY || '',
    birdeyeApiKey: env.BIRDEYE_API_KEY || '',
    providerMode: env.PROVIDER_MODE === 'cache-only' ? 'cache-only' : 'live',
  };
}
