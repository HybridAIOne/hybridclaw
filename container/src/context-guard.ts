/**
 * Whole-context pressure compacts historical results and triggers recovery.
 * Individual tool results have no preview cap; unlike IPC spilling, this guard
 * only changes evidence when the combined context exceeds its budget.
 */
import {
  CONTEXT_GUARD_DEFAULTS,
  normalizeContextGuardConfig,
} from '../shared/context-guard-config.js';
import {
  estimateChatMessageTokens,
  estimateMessageTokens,
  type TokenEstimateCache,
} from './token-usage.js';
import type { ChatMessage, ContextGuardConfig } from './types.js';

export const COMPACTED_TOOL_RESULT_PLACEHOLDER =
  '[Historical tool result compacted to preserve context budget.]';
const compactedToolMessages = new WeakSet<ChatMessage>();

export interface ContextGuardResult {
  totalTokensAfter: number;
  overflowBudgetTokens: number;
  compactedToolResults: number;
  tier3Triggered: boolean;
}

function resolveConfig(
  config?: Partial<ContextGuardConfig>,
): ContextGuardConfig {
  return normalizeContextGuardConfig(config, CONTEXT_GUARD_DEFAULTS);
}

function isToolMessage(message: ChatMessage): boolean {
  return message.role === 'tool';
}

function isCompactedToolMessage(message: ChatMessage): boolean {
  return compactedToolMessages.has(message);
}

function updateMessageContent(
  message: ChatMessage,
  nextContent: string,
  cache?: TokenEstimateCache,
): number {
  const previousTokens = estimateChatMessageTokens(message, cache);
  message.content = nextContent;
  cache?.delete(message);
  const nextTokens = estimateChatMessageTokens(message, cache);
  return nextTokens - previousTokens;
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
      compactedToolResults: 0,
      tier3Triggered: false,
    };
  }

  const promptOverheadTokens = Math.max(
    0,
    Math.floor(params.promptOverheadTokens || 0),
  );
  const tier3BudgetTokens =
    promptOverheadTokens > 0 ? contextWindowTokens : overflowBudgetTokens;
  let totalTokens =
    estimateMessageTokens(params.history, params.cache) + promptOverheadTokens;
  let compactedToolResults = 0;

  if (totalTokens > compactionBudgetTokens) {
    for (const message of params.history) {
      if (totalTokens <= compactionBudgetTokens) break;
      if (!isToolMessage(message) || isCompactedToolMessage(message)) continue;

      totalTokens += updateMessageContent(
        message,
        COMPACTED_TOOL_RESULT_PLACEHOLDER,
        params.cache,
      );
      compactedToolMessages.add(message);
      compactedToolResults += 1;
    }
  }

  return {
    totalTokensAfter: totalTokens,
    overflowBudgetTokens,
    compactedToolResults,
    tier3Triggered: totalTokens > tier3BudgetTokens,
  };
}
