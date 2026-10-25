/**
 * Environment validation and effective runtime configuration.
 * @packageDocumentation
 */

import type { WorkerVariables } from './env.ts';

/** Effective Worker environment, origins and provider configuration. */
export interface WorkerConfig {
  corsOrigins: string[];
  heliusApiKey: string;
  jupiterApiKey: string;
  birdeyeApiKey: string;
  providerMode: 'cache-only' | 'live';
}

/** Effective upstream-provider options resolved from environment bindings. */
export type ProviderConfig = Partial<
  Pick<
    WorkerConfig,
    'heliusApiKey' | 'jupiterApiKey' | 'birdeyeApiKey' | 'providerMode'
  >
>;

/** Resolve the Worker configuration from the current environment bindings.
 * @param env - Current public settings and server-only provider credentials.
 * @returns Trimmed allowed origins, selected credentials and explicit provider mode.
 */
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
