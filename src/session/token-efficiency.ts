import type { ChatMessage } from '../types/api.js';

export const DEFAULT_CHARS_PER_TOKEN = 4;
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
    if (message.role === 'user' && currentTurn.length > 0) {
      turns.push(currentTurn);
      currentTurn = [];
    }
    currentTurn.push(message);
  }
  if (currentTurn.length > 0) turns.push(currentTurn);

  return turns;
}

export function estimateTokenCountFromText(
  text: string | null | undefined,
): number {
  const normalized = typeof text === 'string' ? text : '';
  if (!normalized) return 0;
  return Math.max(1, Math.ceil(normalized.length / DEFAULT_CHARS_PER_TOKEN));
}

function normalizeMessageContentToText(
  content: ChatMessage['content'],
): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const chunks: string[] = [];
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') {
      chunks.push(part.text);
      continue;
    }
    if (part?.type === 'image_url' && part.image_url?.url) {
      chunks.push('[image]');
      continue;
    }
    if (part?.type === 'audio_url' && part.audio_url?.url) {
      chunks.push('[audio]');
    }
  }
  return chunks.join('\n');
}

export function estimateTokenCountFromMessages(
  messages: ChatMessage[],
): number {
  if (!Array.isArray(messages) || messages.length === 0) return 0;

  let total = 2; // Approximate completion priming overhead.
  for (const message of messages) {
    total += 4; // Approximate per-message framing overhead.
    total += estimateTokenCountFromText(message.role);
    total += estimateTokenCountFromText(
      message.tool_calls ? JSON.stringify(message.tool_calls) : null,
    );
    total += estimateTokenCountFromText(
      message.anthropic_content
        ? JSON.stringify(message.anthropic_content)
        : null,
    );
    total += estimateTokenCountFromText(
      message.openai_response_items
        ? JSON.stringify(message.openai_response_items)
        : null,
    );
    total += estimateTokenCountFromText(
      normalizeMessageContentToText(message.content),
    );
  }
  return total;
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
  const turnTokens = turns.map((turn) => estimateTokenCountFromMessages(turn));
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
