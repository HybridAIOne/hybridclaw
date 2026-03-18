import {
  estimateChatMessageTokens,
  estimateMessageTokens,
  estimateToolResultTokens,
  normalizeContentText,
  TOOL_RESULT_CHARS_PER_TOKEN,
  type TokenEstimateCache,
} from './token-usage.js';
import type { ChatMessage, ContextGuardConfig } from './types.js';

const DEFAULT_CONTEXT_GUARD_CONFIG: ContextGuardConfig = {
  enabled: true,
  perResultShare: 0.5,
  compactionRatio: 0.75,
  overflowRatio: 0.9,
  maxRetries: 3,
};

const TOOL_RESULT_TRUNCATED_MARKER =
  '\n\n...[tool result truncated by context guard]...\n\n';
export const COMPACTED_TOOL_RESULT_PLACEHOLDER =
  '[Historical tool result compacted to preserve context budget.]';

export interface ContextGuardResult {
  totalTokensBefore: number;
  totalTokensAfter: number;
  perResultLimitTokens: number;
  compactionBudgetTokens: number;
  overflowBudgetTokens: number;
  truncatedToolResults: number;
  compactedToolResults: number;
  tier3Triggered: boolean;
}

function resolveConfig(
  config?: Partial<ContextGuardConfig>,
): ContextGuardConfig {
  const perResultShare = Math.max(
    0.1,
    Math.min(
      0.9,
      config?.perResultShare ?? DEFAULT_CONTEXT_GUARD_CONFIG.perResultShare,
    ),
  );
  const compactionRatio = Math.max(
    0.2,
    Math.min(
      0.98,
      config?.compactionRatio ?? DEFAULT_CONTEXT_GUARD_CONFIG.compactionRatio,
    ),
  );
  const overflowRatio = Math.max(
    compactionRatio,
    Math.min(
      0.99,
      config?.overflowRatio ?? DEFAULT_CONTEXT_GUARD_CONFIG.overflowRatio,
    ),
  );

  return {
    enabled: config?.enabled ?? DEFAULT_CONTEXT_GUARD_CONFIG.enabled,
    perResultShare,
    compactionRatio,
    overflowRatio,
    maxRetries: Math.max(
      0,
      Math.min(
        10,
        config?.maxRetries ?? DEFAULT_CONTEXT_GUARD_CONFIG.maxRetries,
      ),
    ),
  };
}

function isToolMessage(message: ChatMessage): boolean {
  return message.role === 'tool';
}

function isCompactedToolMessage(message: ChatMessage): boolean {
  return (
    normalizeContentText(message.content) === COMPACTED_TOOL_RESULT_PLACEHOLDER
  );
}

function truncateToolResultText(content: string, maxTokens: number): string {
  const maxChars = Math.max(
    TOOL_RESULT_TRUNCATED_MARKER.length + 16,
    Math.floor(maxTokens * TOOL_RESULT_CHARS_PER_TOKEN),
  );
  if (content.length <= maxChars) return content;

  const available = maxChars - TOOL_RESULT_TRUNCATED_MARKER.length;
  if (available <= 0) return content.slice(0, maxChars);

  let headChars = Math.floor(available * 0.7);
  let tailChars = Math.floor(available * 0.2);
  if (headChars + tailChars > available) {
    const scale = available / Math.max(1, headChars + tailChars);
    headChars = Math.floor(headChars * scale);
    tailChars = Math.floor(tailChars * scale);
  }
  headChars += Math.max(0, available - (headChars + tailChars));

  if (tailChars <= 0) {
    return `${content.slice(0, headChars)}${TOOL_RESULT_TRUNCATED_MARKER}`;
  }
  return `${content.slice(0, headChars)}${TOOL_RESULT_TRUNCATED_MARKER}${content.slice(content.length - tailChars)}`;
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
  let totalTokens = estimateMessageTokens(params.history, params.cache);
  const totalTokensBefore = totalTokens;
  let truncatedToolResults = 0;
  let compactedToolResults = 0;

  if (!config.enabled || params.history.length === 0) {
    return {
      totalTokensBefore,
      totalTokensAfter: totalTokens,
      perResultLimitTokens,
      compactionBudgetTokens,
      overflowBudgetTokens,
      truncatedToolResults,
      compactedToolResults,
      tier3Triggered: false,
    };
  }

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
      compactedToolResults += 1;
    }
  }

  return {
    totalTokensBefore,
    totalTokensAfter: totalTokens,
    perResultLimitTokens,
    compactionBudgetTokens,
    overflowBudgetTokens,
    truncatedToolResults,
    compactedToolResults,
    tier3Triggered: totalTokens > overflowBudgetTokens,
  };
}
