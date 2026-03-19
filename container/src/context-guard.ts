import {
  CONTEXT_GUARD_DEFAULTS,
  normalizeContextGuardConfig,
} from '../shared/context-guard-config.js';
import { truncateHeadTailText } from './text-truncation.js';
import {
  estimateChatMessageTokens,
  estimateMessageTokens,
  estimateToolResultTokens,
  normalizeContentText,
  TOOL_RESULT_CHARS_PER_TOKEN,
  type TokenEstimateCache,
} from './token-usage.js';
import type { ChatMessage, ContextGuardConfig } from './types.js';

const TOOL_RESULT_TRUNCATED_MARKER =
  '\n\n...[tool result truncated by context guard]...\n\n';
export const COMPACTED_TOOL_RESULT_PLACEHOLDER =
  '[Historical tool result compacted to preserve context budget.]';
const compactedToolMessages = new WeakSet<ChatMessage>();

export interface ContextGuardResult {
  totalTokensAfter: number;
  overflowBudgetTokens: number;
  truncatedToolResults: number;
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

function truncateToolResultText(content: string, maxTokens: number): string {
  const maxChars = Math.max(
    TOOL_RESULT_TRUNCATED_MARKER.length + 16,
    Math.floor(maxTokens * TOOL_RESULT_CHARS_PER_TOKEN),
  );
  return truncateHeadTailText({
    text: content,
    maxChars,
    marker: TOOL_RESULT_TRUNCATED_MARKER,
    headRatio: 0.7,
    tailRatio: 0.2,
  });
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
  config?: Partial<ContextGuardConfig>;
  cache?: TokenEstimateCache;
}): ContextGuardResult {
  const config = resolveConfig(params.config);
  const contextWindowTokens = Math.max(
    1_024,
    Math.floor(params.contextWindowTokens || 128_000),
  );
  const perResultLimitTokens = Math.max(
    1,
    Math.floor(contextWindowTokens * config.perResultShare),
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
      truncatedToolResults: 0,
      compactedToolResults: 0,
      tier3Triggered: false,
    };
  }

  let totalTokens = estimateMessageTokens(params.history, params.cache);
  let truncatedToolResults = 0;
  let compactedToolResults = 0;

  for (const message of params.history) {
    if (!isToolMessage(message)) continue;
    const content = normalizeContentText(message.content);
    if (!content) continue;
    if (estimateToolResultTokens(content) <= perResultLimitTokens) continue;

    const truncated = truncateToolResultText(content, perResultLimitTokens);
    if (truncated === content) continue;
    totalTokens += updateMessageContent(message, truncated, params.cache);
    truncatedToolResults += 1;
  }

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
    truncatedToolResults,
    compactedToolResults,
    tier3Triggered: totalTokens > overflowBudgetTokens,
  };
}
