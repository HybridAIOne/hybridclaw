/**
 * Measures whole-context pressure without changing evidence or token caches.
 * Unlike in-loop compaction, this guard never replaces messages or tool results;
 * a successful archived summary is the only way the loop prunes context.
 */
import {
  CONTEXT_GUARD_DEFAULTS,
  normalizeContextGuardConfig,
} from '../shared/context-guard-config.js';
import {
  estimateMessageTokens,
  type TokenEstimateCache,
} from './token-usage.js';
import type { ChatMessage, ContextGuardConfig } from './types.js';

export interface ContextGuardResult {
  totalTokensAfter: number;
  overflowBudgetTokens: number;
  tier3Triggered: boolean;
}

function resolveConfig(
  config?: Partial<ContextGuardConfig>,
): ContextGuardConfig {
  return normalizeContextGuardConfig(config, CONTEXT_GUARD_DEFAULTS);
}

export function applyContextGuard(params: {
  history: ChatMessage[];
  contextWindowTokens?: number;
  promptOverheadTokens?: number;
  config?: Partial<ContextGuardConfig>;
  cache?: TokenEstimateCache;
}): ContextGuardResult {
  const config = resolveConfig(params.config);
  const contextWindowTokens = Math.max(
    1_024,
    Math.floor(params.contextWindowTokens || 128_000),
  );
  const compactionBudgetTokens = Math.max(
    1,
    Math.floor(contextWindowTokens * config.compactionRatio),
  );
  const overflowBudgetTokens = Math.max(
    compactionBudgetTokens,
    Math.floor(contextWindowTokens * config.overflowRatio),
  );

  if (!config.enabled || params.history.length === 0) {
    return {
      totalTokensAfter: 0,
      overflowBudgetTokens,
      tier3Triggered: false,
    };
  }

  const promptOverheadTokens = Math.max(
    0,
    Math.floor(params.promptOverheadTokens || 0),
  );
  const tier3BudgetTokens =
    promptOverheadTokens > 0 ? contextWindowTokens : overflowBudgetTokens;
  const totalTokens =
    estimateMessageTokens(params.history, params.cache) + promptOverheadTokens;

  return {
    totalTokensAfter: totalTokens,
    overflowBudgetTokens,
    tier3Triggered: totalTokens > tier3BudgetTokens,
  };
}
