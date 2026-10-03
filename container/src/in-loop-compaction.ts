/**
 * Replaces a complete, tool-safe region only with a smaller model summary.
 * Every selected message reaches the summarizer intact and is archived before
 * replacement. Unlike gateway session compaction, this changes only loop input;
 * failed or empty summaries never authorize a lossy heuristic replacement.
 */
import { estimateMessageTokens } from './token-usage.js';
import type { ChatMessage } from './types.js';

const PROTECT_HEAD_MESSAGES = 4;
const PROTECT_TAIL_MESSAGES = 8;
const SUMMARY_LABEL = '[In-loop compaction summary]';

export interface InLoopCompactionResult {
  history: ChatMessage[];
  changed: boolean;
  compactedMessages: number;
  summarySource: 'llm' | 'none';
}

function countLeadingSystemMessages(history: ChatMessage[]): number {
  let count = 0;
  while (count < history.length && history[count]?.role === 'system') {
    count += 1;
  }
  return count;
}

function findSafeToolExchangeBoundaries(body: ChatMessage[]): boolean[] {
  const safe = Array.from({ length: body.length + 1 }, () => true);

  for (let index = 0; index < body.length; index += 1) {
    const message = body[index];
    if (
      message?.role !== 'assistant' ||
      !Array.isArray(message.tool_calls) ||
      message.tool_calls.length === 0
    ) {
      continue;
    }

    let resultEnd = index + 1;
    while (body[resultEnd]?.role === 'tool') {
      resultEnd += 1;
    }

    // The assistant tool-call message and all immediately following results
    // form one protocol-level exchange. A compaction boundary inside it would
    // leave either unanswered tool calls or orphaned tool results.
    const firstUnsafeBoundary = index + 1;
    const lastUnsafeBoundary = Math.max(firstUnsafeBoundary, resultEnd - 1);
    for (
      let boundary = firstUnsafeBoundary;
      boundary <= lastUnsafeBoundary;
      boundary += 1
    ) {
      safe[boundary] = false;
    }
  }

  return safe;
}

function findSafeBoundaryAtOrAfter(safe: boolean[], target: number): number {
  for (let boundary = target; boundary < safe.length; boundary += 1) {
    if (safe[boundary]) return boundary;
  }
  return safe.length - 1;
}

function findSafeBoundaryAtOrBefore(safe: boolean[], target: number): number {
  for (let boundary = target; boundary >= 0; boundary -= 1) {
    if (safe[boundary]) return boundary;
  }
  return 0;
}

function normalizeSummary(summary: string): string {
  let normalized = summary.trim();
  if (normalized.startsWith('```')) {
    normalized = normalized
      .replace(/^```[a-z0-9_-]*\s*/i, '')
      .replace(/```$/i, '')
      .trim();
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
  const safeBoundaries = findSafeToolExchangeBoundaries(body);
  if (headCount + tailCount >= body.length) {
    // If the default protected slices would consume the whole body, fall back
    // to a smaller 2+4 split so the compaction region still has something to
    // summarize instead of collapsing to an empty middle.
    headCount = Math.min(2, Math.max(0, body.length - 1));
    tailCount = Math.min(4, Math.max(1, body.length - headCount - 1));
  }

  let middleStart = findSafeBoundaryAtOrAfter(safeBoundaries, headCount);
  let middleEnd = findSafeBoundaryAtOrBefore(
    safeBoundaries,
    body.length - tailCount,
  );
  if (middleStart >= middleEnd) {
    headCount = Math.min(2, Math.max(0, body.length - 1));
    tailCount = Math.min(4, Math.max(1, body.length - headCount - 1));
    middleStart = findSafeBoundaryAtOrAfter(safeBoundaries, headCount);
    middleEnd = findSafeBoundaryAtOrBefore(
      safeBoundaries,
      body.length - tailCount,
    );
  }
  if (middleStart >= middleEnd) {
    return { prefix: history.slice(), middle: [], suffix: [] };
  }
  return {
    prefix: [...systemPrefix, ...body.slice(0, middleStart)],
    middle: body.slice(middleStart, middleEnd),
    suffix: body.slice(middleEnd),
  };
}

function buildSummaryPromptMessages(compacted: ChatMessage[]): ChatMessage[] {
  return [
    ...compacted,
    {
      role: 'user',
      content: [
        'Summarize the preceding conversation region so the agent can continue working without losing state.',
        'Preserve the user goal, active plan, tool outputs that still matter, file paths, commands, URLs, errors, decisions, and unresolved follow-ups.',
        'Drop filler and repetitive detail.',
        'Return a concise plain markdown summary only. Do not execute tools or continue the task.',
      ].join('\n'),
    },
  ];
}

export async function compactInLoop(params: {
  history: ChatMessage[];
  contextWindowTokens?: number;
  summarize: (messages: ChatMessage[], maxTokens: number) => Promise<string>;
  archive: (messages: ChatMessage[]) => string;
}): Promise<InLoopCompactionResult> {
  const region = buildCompactionRegion(params.history);
  const unchanged: InLoopCompactionResult = {
    history: params.history,
    changed: false,
    compactedMessages: 0,
    summarySource: 'none',
  };
  if (region.middle.length === 0) return unchanged;

  const contextWindowTokens = Math.max(
    1_024,
    Math.floor(params.contextWindowTokens || 128_000),
  );
  const maxSummaryTokens = Math.max(
    256,
    Math.min(1_024, Math.floor(contextWindowTokens * 0.08)),
  );

  // Keep the archive independent of any provider-side message normalization.
  const originals = structuredClone(region.middle);
  let summary: string;
  try {
    summary = normalizeSummary(
      await params.summarize(
        buildSummaryPromptMessages(structuredClone(originals)),
        maxSummaryTokens,
      ),
    );
  } catch {
    return unchanged;
  }
  if (!summary) return unchanged;

  const summaryMessage: ChatMessage = {
    role: 'assistant',
    content: `${SUMMARY_LABEL}\n${summary}`,
  };
  const originalTokens = estimateMessageTokens(originals);
  if (estimateMessageTokens([summaryMessage]) >= originalTokens) {
    return unchanged;
  }

  let archivePath: string;
  try {
    archivePath = params.archive(originals);
  } catch {
    return unchanged;
  }
  summaryMessage.content += `\n\nOriginal messages: ${archivePath}`;
  if (estimateMessageTokens([summaryMessage]) >= originalTokens) {
    return unchanged;
  }

  return {
    history: [...region.prefix, summaryMessage, ...region.suffix],
    changed: true,
    compactedMessages: region.middle.length,
    summarySource: 'llm',
  };
}
