import type { MemoryBackend } from './memory-service.js';

export interface MemoryConsolidationConfig {
  decayRate: number;
  staleAfterDays: number;
  minConfidence: number;
}

export interface MemoryConsolidationReport {
  memoriesDecayed: number;
  durationMs: number;
}

export class MemoryConsolidationEngine {
  private readonly backend: MemoryBackend;
  private readonly config: MemoryConsolidationConfig;

  constructor(backend: MemoryBackend, config: MemoryConsolidationConfig) {
    this.backend = backend;
    this.config = config;
  }

  consolidate(
    overrides?: Partial<MemoryConsolidationConfig>,
  ): MemoryConsolidationReport {
    const start = Date.now();
    const config = {
      ...this.config,
      ...(overrides || {}),
    };
    const memoriesDecayed = this.backend.decaySemanticMemories({
      decayRate: config.decayRate,
      staleAfterDays: config.staleAfterDays,
      minConfidence: config.minConfidence,
    });
    return {
      memoriesDecayed,
      durationMs: Math.max(0, Date.now() - start),
    };
  }
}
