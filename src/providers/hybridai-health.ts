import { probeHybridAI } from '../doctor/provider-probes.js';
import { logger } from '../logger.js';
import { createOnDemandProbe } from './on-demand-probe.js';

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
    return {
      reachable: result.reachable,
      modelCount: result.modelCount,
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ err: error }, 'HybridAI health probe failed');
    return {
      reachable: false,
      error: message,
      latencyMs: Date.now() - startedAt,
    };
  }
}

export const hybridAIProbe = createOnDemandProbe(runProbe, PROBE_TTL_MS);
