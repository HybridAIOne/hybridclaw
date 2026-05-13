import { probeHybridAI } from '../doctor/provider-probes.js';
import { logger } from '../logger.js';
import { createOnDemandProbe } from './on-demand-probe.js';
import { formatUnknownError } from './utils.js';

const PROBE_TTL_MS = 30_000;

export interface HybridAIHealthResult {
  reachable: boolean;
  latencyMs: number;
  modelCount?: number;
  error?: string;
}

async function runProbe(): Promise<HybridAIHealthResult> {
  const startedAt = Date.now();
  try {
    const result = await probeHybridAI();
    const health: HybridAIHealthResult = {
      reachable: result.reachable,
      modelCount: result.modelCount,
      latencyMs: Date.now() - startedAt,
    };
    if (!result.reachable && result.detail) {
      health.error = result.detail;
    }
    return health;
  } catch (error) {
    const message = formatUnknownError(error);
    logger.warn({ error: message }, 'HybridAI health probe failed');
    return {
      reachable: false,
      error: message,
      latencyMs: Date.now() - startedAt,
    };
  }
}

export const hybridAIProbe = createOnDemandProbe(runProbe, PROBE_TTL_MS);
