import type { ChatMessage } from '../types/api.js';

export const DEFAULT_CHARS_PER_TOKEN = 4;
export const DEFAULT_HISTORY_MAX_TOTAL_CHARS = 24_000;
export const DEFAULT_HISTORY_MAX_MESSAGE_CHARS = 1_200;
export const DEFAULT_HISTORY_PROTECT_HEAD_MESSAGES = 4;
export const DEFAULT_HISTORY_PROTECT_TAIL_MESSAGES = 8;
export const DEFAULT_BOOTSTRAP_HEAD_RATIO = 0.7;
export const DEFAULT_BOOTSTRAP_TAIL_RATIO = 0.2;

const MESSAGE_TRUNCATED_MARKER = '\n...[truncated]';
const HEAD_TAIL_TRUNCATED_MARKER = '\n\n...[truncated]...\n\n';

interface PromptHistoryMessage {
  role: ChatMessage['role'];
  content: string;
}

export interface HistoryOptimizationOptions {
  maxTotalChars: number;
  maxMessageChars: number;
  protectHeadMessages: number;
  protectTailMessages: number;
}

export interface HistoryOptimizationStats {
  originalCount: number;
  includedCount: number;
  droppedCount: number;
  originalChars: number;
  preBudgetChars: number;
  includedChars: number;
  droppedChars: number;
  maxTotalChars: number;
  maxMessageChars: number;
  perMessageTruncatedCount: number;
  middleCompressionApplied: boolean;
}

function normalizePositiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function sumChars(messages: PromptHistoryMessage[]): number {
  return messages.reduce((total, message) => total + message.content.length, 0);
}

function trimToRecentWithinBudget(
  messages: PromptHistoryMessage[],
  maxTotalChars: number,
): PromptHistoryMessage[] {
  if (messages.length === 0 || maxTotalChars <= 0) return [];

  const kept: PromptHistoryMessage[] = [];
  let usedChars = 0;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const size = message.content.length;
    if (size > maxTotalChars) continue;
    if (usedChars + size > maxTotalChars) continue;
    kept.push(message);
    usedChars += size;
  }

  return kept.reverse();
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
  messages: Array<Pick<ChatMessage, 'role' | 'content'>>,
): number {
  if (!Array.isArray(messages) || messages.length === 0) return 0;

  let total = 2; // Approximate completion priming overhead.
  for (const message of messages) {
    total += 4; // Approximate per-message framing overhead.
    total += estimateTokenCountFromText(message.role);
    total += estimateTokenCountFromText(
      normalizeMessageContentToText(message.content),
    );
  }
  return total;
}

export function truncateMessageContent(
  content: string,
  maxChars: number,
): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return '';
  if (content.length <= maxChars) return content;

  const bodyMax = Math.max(
    0,
    Math.floor(maxChars) - MESSAGE_TRUNCATED_MARKER.length,
  );
  if (bodyMax <= 0) {
    return content.slice(0, Math.floor(maxChars));
  }
  return `${content.slice(0, bodyMax)}${MESSAGE_TRUNCATED_MARKER}`;
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
  if (available <= 0) return content.slice(0, budget);

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
  if (safeTail === 0) return `${content.slice(0, safeHead)}${marker}`;
  return `${content.slice(0, safeHead)}${marker}${content.slice(content.length - safeTail)}`;
}

export function optimizeHistoryMessagesForPrompt(
  messages: PromptHistoryMessage[],
  options?: Partial<HistoryOptimizationOptions>,
): { messages: PromptHistoryMessage[]; stats: HistoryOptimizationStats } {
  const maxTotalChars = normalizePositiveInt(
    options?.maxTotalChars ?? DEFAULT_HISTORY_MAX_TOTAL_CHARS,
    DEFAULT_HISTORY_MAX_TOTAL_CHARS,
  );
  const maxMessageChars = normalizePositiveInt(
    options?.maxMessageChars ?? DEFAULT_HISTORY_MAX_MESSAGE_CHARS,
    DEFAULT_HISTORY_MAX_MESSAGE_CHARS,
  );
  const protectHeadMessages = Math.max(
    0,
    Math.floor(
      options?.protectHeadMessages ?? DEFAULT_HISTORY_PROTECT_HEAD_MESSAGES,
    ),
  );
  const protectTailMessages = Math.max(
    0,
    Math.floor(
      options?.protectTailMessages ?? DEFAULT_HISTORY_PROTECT_TAIL_MESSAGES,
    ),
  );

  const originalCount = messages.length;
  const originalChars = messages.reduce(
    (total, message) => total + message.content.length,
    0,
  );
  let perMessageTruncatedCount = 0;

  const normalized = messages.map((message) => {
    const bounded = truncateMessageContent(message.content, maxMessageChars);
    if (bounded !== message.content) perMessageTruncatedCount += 1;
    return {
      role: message.role,
      content: bounded,
    };
  });

  const preBudgetChars = sumChars(normalized);
  let included = [...normalized];
  let middleCompressionApplied = false;

  if (preBudgetChars > maxTotalChars) {
    middleCompressionApplied = true;
    const headCount = Math.min(protectHeadMessages, normalized.length);
    const tailCount = Math.min(
      protectTailMessages,
      Math.max(0, normalized.length - headCount),
    );
    const middleStart = headCount;
    const middleEnd = normalized.length - tailCount;
    const head = normalized.slice(0, headCount);
    const middle = normalized.slice(middleStart, middleEnd);
    const tail = normalized.slice(middleEnd);

    const base = [...head, ...tail];
    const baseChars = sumChars(base);

    if (baseChars >= maxTotalChars) {
      included = trimToRecentWithinBudget(base, maxTotalChars);
    } else {
      const selectedMiddleRev: PromptHistoryMessage[] = [];
      let usedChars = baseChars;
      for (let i = middle.length - 1; i >= 0; i -= 1) {
        const candidate = middle[i];
        const nextSize = candidate.content.length;
        if (usedChars + nextSize > maxTotalChars) continue;
        selectedMiddleRev.push(candidate);
        usedChars += nextSize;
      }
      const selectedMiddle = selectedMiddleRev.reverse();
      included = [...head, ...selectedMiddle, ...tail];
      if (sumChars(included) > maxTotalChars) {
        included = trimToRecentWithinBudget(included, maxTotalChars);
      }
    }
  }

  const includedChars = sumChars(included);
  const droppedCount = Math.max(0, normalized.length - included.length);
  const droppedChars = Math.max(0, preBudgetChars - includedChars);

  return {
    messages: included,
    stats: {
      originalCount,
      includedCount: included.length,
      droppedCount,
      originalChars,
      preBudgetChars,
      includedChars,
      droppedChars,
      maxTotalChars,
      maxMessageChars,
      perMessageTruncatedCount,
      middleCompressionApplied,
    },
  };
}
