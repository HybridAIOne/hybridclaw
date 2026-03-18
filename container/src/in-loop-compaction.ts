import { normalizeContentText } from './token-usage.js';
import type { ChatMessage } from './types.js';

const PROTECT_HEAD_MESSAGES = 4;
const PROTECT_TAIL_MESSAGES = 8;
const SUMMARY_LABEL = '[In-loop compaction summary]';
const SUMMARY_TRUNCATED_MARKER = '\n\n...[truncated]';

export interface InLoopCompactionResult {
  history: ChatMessage[];
  changed: boolean;
  compactedMessages: number;
  summarySource: 'llm' | 'heuristic' | 'none';
}

function truncateInline(text: string, maxChars = 240): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 3)}...`;
}

function truncateForPrompt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const available = maxChars - SUMMARY_TRUNCATED_MARKER.length;
  if (available <= 0) return text.slice(0, maxChars);

  let headChars = Math.floor(available * 0.75);
  let tailChars = Math.floor(available * 0.15);
  if (headChars + tailChars > available) {
    tailChars = Math.max(0, available - headChars);
  } else {
    headChars += available - (headChars + tailChars);
  }

  if (tailChars === 0) {
    return `${text.slice(0, headChars)}${SUMMARY_TRUNCATED_MARKER}`;
  }
  return `${text.slice(0, headChars)}${SUMMARY_TRUNCATED_MARKER}${text.slice(text.length - tailChars)}`;
}

function countLeadingSystemMessages(history: ChatMessage[]): number {
  let count = 0;
  while (count < history.length && history[count]?.role === 'system') {
    count += 1;
  }
  return count;
}

function normalizeSummary(summary: string, maxChars: number): string {
  let normalized = summary.trim();
  if (normalized.startsWith('```')) {
    normalized = normalized
      .replace(/^```[a-z0-9_-]*\s*/i, '')
      .replace(/```$/i, '')
      .trim();
  }
  if (normalized.length > maxChars) {
    normalized = `${normalized.slice(0, maxChars)}${SUMMARY_TRUNCATED_MARKER}`;
  }
  return normalized.trim();
}

function buildCompactionRegion(history: ChatMessage[]): {
  prefix: ChatMessage[];
  middle: ChatMessage[];
  suffix: ChatMessage[];
} {
  const leadingSystemCount = countLeadingSystemMessages(history);
  const systemPrefix = history.slice(0, leadingSystemCount);
  const body = history.slice(leadingSystemCount);
  if (body.length <= 1) {
    return { prefix: history.slice(), middle: [], suffix: [] };
  }

  let headCount = Math.min(PROTECT_HEAD_MESSAGES, body.length);
  let tailCount = Math.min(
    PROTECT_TAIL_MESSAGES,
    Math.max(0, body.length - headCount),
  );
  if (headCount + tailCount >= body.length) {
    headCount = Math.min(2, Math.max(0, body.length - 1));
    tailCount = Math.min(4, Math.max(1, body.length - headCount - 1));
  }

  const middleStart = headCount;
  const middleEnd = Math.max(middleStart, body.length - tailCount);
  return {
    prefix: [...systemPrefix, ...body.slice(0, middleStart)],
    middle: body.slice(middleStart, middleEnd),
    suffix: body.slice(middleEnd),
  };
}

function formatMessagesForPrompt(
  messages: ChatMessage[],
  maxChars: number,
): string {
  const lines: string[] = [];
  let usedChars = 0;
  for (const message of messages) {
    const content = normalizeContentText(message.content).trim() || '(empty)';
    const entry = [
      '---',
      `role=${message.role}`,
      truncateForPrompt(content, 2_000),
    ].join('\n');
    if (usedChars + entry.length + 2 > maxChars) break;
    lines.push(entry);
    usedChars += entry.length + 2;
  }
  return lines.join('\n\n');
}

function buildHeuristicSummary(messages: ChatMessage[]): string {
  const counts = new Map<ChatMessage['role'], number>();
  for (const message of messages) {
    counts.set(message.role, (counts.get(message.role) || 0) + 1);
  }
  const roleCounts = Array.from(counts.entries())
    .map(([role, count]) => `${role}: ${count}`)
    .join(', ');
  const highlights = messages
    .slice(-6)
    .map(
      (message) =>
        `- ${message.role}: ${truncateInline(normalizeContentText(message.content), 280)}`,
    )
    .join('\n');

  return [
    'Compacted earlier conversation to stay within the active model context window.',
    `Compacted messages: ${messages.length}.`,
    roleCounts ? `Roles in compacted region: ${roleCounts}.` : '',
    highlights ? `Most recent compacted highlights:\n${highlights}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function buildSummaryPromptMessages(params: {
  compacted: ChatMessage[];
  maxTranscriptChars: number;
}): ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        'You are compacting earlier turns from an active tool-using agent loop.',
        'Summarize the conversation region so the agent can continue working without losing state.',
        'Preserve the user goal, active plan, tool outputs that still matter, file paths, commands, URLs, errors, decisions, and unresolved follow-ups.',
        'Drop filler and repetitive detail.',
        'Return plain markdown only.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        'Compacted conversation region:',
        formatMessagesForPrompt(params.compacted, params.maxTranscriptChars),
        '',
        'Write a concise summary that can replace these messages in history.',
      ].join('\n'),
    },
  ];
}

export async function compactInLoop(params: {
  history: ChatMessage[];
  contextWindowTokens?: number;
  summarize: (messages: ChatMessage[], maxTokens: number) => Promise<string>;
}): Promise<InLoopCompactionResult> {
  const region = buildCompactionRegion(params.history);
  if (region.middle.length === 0) {
    return {
      history: params.history,
      changed: false,
      compactedMessages: 0,
      summarySource: 'none',
    };
  }

  const contextWindowTokens = Math.max(
    1_024,
    Math.floor(params.contextWindowTokens || 128_000),
  );
  const maxTranscriptChars = Math.max(
    6_000,
    Math.min(32_000, Math.floor(contextWindowTokens * 1.5)),
  );
  const maxSummaryChars = Math.max(
    1_200,
    Math.min(6_000, Math.floor(contextWindowTokens * 0.08)),
  );
  const maxSummaryTokens = Math.max(
    256,
    Math.min(1_024, Math.floor(contextWindowTokens * 0.08)),
  );

  let summarySource: InLoopCompactionResult['summarySource'] = 'llm';
  let summary: string;
  try {
    summary = await params.summarize(
      buildSummaryPromptMessages({
        compacted: region.middle,
        maxTranscriptChars,
      }),
      maxSummaryTokens,
    );
  } catch {
    summarySource = 'heuristic';
    summary = buildHeuristicSummary(region.middle);
  }

  const normalizedSummary = normalizeSummary(summary, maxSummaryChars);
  if (!normalizedSummary) {
    summarySource = 'heuristic';
    summary = buildHeuristicSummary(region.middle);
  }
  const finalSummary = normalizeSummary(
    summarySource === 'heuristic' ? summary : normalizedSummary,
    maxSummaryChars,
  );
  const summaryMessage: ChatMessage = {
    role: 'assistant',
    content: `${SUMMARY_LABEL}\n${finalSummary}`,
  };

  return {
    history: [...region.prefix, summaryMessage, ...region.suffix],
    changed: true,
    compactedMessages: region.middle.length,
    summarySource,
  };
}
