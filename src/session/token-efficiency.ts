/**
 * Prompt history shaping: drops whole older turns to fit a token budget and
 * truncates text without splitting a surrogate pair. It never estimates tokens
 * itself; every count comes from `@hybridclaw/shared/token-estimate`, so the
 * gateway and the worker size the same history the same way.
 */
import { isDynamicContextMessageText } from '@hybridclaw/shared/dynamic-context';
import { estimateMessageTokens } from '@hybridclaw/shared/token-estimate';
import type { ChatMessage } from '../types/api.js';

export const DEFAULT_BOOTSTRAP_HEAD_RATIO = 0.7;
export const DEFAULT_BOOTSTRAP_TAIL_RATIO = 0.2;

const HEAD_TAIL_TRUNCATED_MARKER = '\n\n...[truncated]...\n\n';

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

export function sliceHeadAtCodePointBoundary(
  text: string,
  maxChars: number,
): string {
  let end = Math.max(0, Math.min(Math.floor(maxChars), text.length));
  if (
    end > 0 &&
    end < text.length &&
    isHighSurrogate(text.charCodeAt(end - 1)) &&
    isLowSurrogate(text.charCodeAt(end))
  ) {
    end -= 1;
  }
  return text.slice(0, end);
}

export function sliceTailAtCodePointBoundary(
  text: string,
  maxChars: number,
): string {
  let start = Math.max(0, text.length - Math.max(0, Math.floor(maxChars)));
  if (
    start > 0 &&
    start < text.length &&
    isHighSurrogate(text.charCodeAt(start - 1)) &&
    isLowSurrogate(text.charCodeAt(start))
  ) {
    start += 1;
  }
  return text.slice(start);
}

type PromptHistoryMessage = ChatMessage;

export interface HistoryOptimizationOptions {
  maxTokens: number;
}

export interface HistoryOptimizationStats {
  originalCount: number;
  includedCount: number;
  droppedCount: number;
  droppedTurns: number;
  originalTokens: number;
  includedTokens: number;
  droppedTokens: number;
  budgetTokens: number;
}

function normalizePositiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function groupHistoryTurns(
  messages: PromptHistoryMessage[],
): PromptHistoryMessage[][] {
  const turns: PromptHistoryMessage[][] = [];
  let currentTurn: PromptHistoryMessage[] = [];

  for (const message of messages) {
    // A replayed dynamic context opens the turn of the user message after it.
    if (
      message.role === 'user' &&
      currentTurn.length > 0 &&
      !isDynamicContextMessageText(currentTurn.at(-1)?.content)
    ) {
      turns.push(currentTurn);
      currentTurn = [];
    }
    currentTurn.push(message);
  }
  if (currentTurn.length > 0) turns.push(currentTurn);

  return turns;
}

export function truncateHeadTailText(
  content: string,
  maxChars: number,
  headRatio = DEFAULT_BOOTSTRAP_HEAD_RATIO,
  tailRatio = DEFAULT_BOOTSTRAP_TAIL_RATIO,
): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return '';
  const budget = Math.floor(maxChars);
  if (content.length <= budget) return content;

  const marker = HEAD_TAIL_TRUNCATED_MARKER;
  const available = budget - marker.length;
  if (available <= 0) return sliceHeadAtCodePointBoundary(content, budget);

  const clampedHeadRatio = Math.max(0, Math.min(1, headRatio));
  const clampedTailRatio = Math.max(0, Math.min(1, tailRatio));

  let headChars = Math.floor(available * clampedHeadRatio);
  let tailChars = Math.floor(available * clampedTailRatio);
  if (headChars + tailChars > available) {
    const scale = available / (headChars + tailChars);
    headChars = Math.floor(headChars * scale);
    tailChars = Math.floor(tailChars * scale);
  }

  const remainder = available - (headChars + tailChars);
  if (remainder > 0) {
    headChars += remainder;
  }

  const safeHead = Math.max(0, Math.min(headChars, content.length));
  const safeTail = Math.max(0, Math.min(tailChars, content.length - safeHead));
  const head = sliceHeadAtCodePointBoundary(content, safeHead);
  if (safeTail === 0) return `${head}${marker}`;
  return `${head}${marker}${sliceTailAtCodePointBoundary(content, safeTail)}`;
}

export function optimizeHistoryMessagesForPrompt(
  messages: PromptHistoryMessage[],
  options: HistoryOptimizationOptions,
): { messages: PromptHistoryMessage[]; stats: HistoryOptimizationStats } {
  const budgetTokens = normalizePositiveInt(
    options.maxTokens,
    Number.MAX_SAFE_INTEGER,
  );
  const turns = groupHistoryTurns(messages);
  const turnTokens = turns.map((turn) => estimateMessageTokens(turn));
  const originalTokens = turnTokens.reduce((total, value) => total + value, 0);

  let firstIncludedTurn = turns.length;
  let includedTokens = 0;
  // Keep the newest turn whole even when it exceeds the budget. Rewriting it
  // here would change the cached prefix on the next turn.
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (
      firstIncludedTurn < turns.length &&
      includedTokens + turnTokens[index] > budgetTokens
    ) {
      break;
    }
    firstIncludedTurn = index;
    includedTokens += turnTokens[index];
  }
  const included = turns.slice(firstIncludedTurn).flat();

  return {
    messages: included,
    stats: {
      originalCount: messages.length,
      includedCount: included.length,
      droppedCount: messages.length - included.length,
      droppedTurns: firstIncludedTurn,
      originalTokens,
      includedTokens,
      droppedTokens: originalTokens - includedTokens,
      budgetTokens,
    },
  };
}
