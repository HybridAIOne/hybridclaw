import { logger } from '../logger.js';
import { resolveModelContextWindowFallback } from '../providers/hybridai-models.js';
import {
  estimateTokenCountFromMessages,
  estimateTokenCountFromText,
} from '../session/token-efficiency.js';
import type { ChatMessage } from '../types/api.js';
import type {
  CompactionConfig,
  CompactionResult,
  CompactionStage,
} from '../types/memory.js';
import type { Session, StoredMessage } from '../types/session.js';
import { archiveTranscript } from './compaction-archive.js';

const STRUCTURED_SUMMARY_SECTIONS = [
  'Goals',
  'Constraints',
  'Progress',
  'Key Decisions',
  'Next Steps',
  'Key Context',
];

const IDENTIFIER_PRESERVATION_INSTRUCTIONS =
  'Preserve opaque identifiers exactly as written, including UUIDs, hashes, filenames, URLs, ports, IDs, and paths.';

const MERGE_SUMMARY_INSTRUCTIONS = [
  'Merge these partial summaries into a single cohesive summary.',
  'Prefer recent context over older context when priorities conflict.',
  'Preserve the latest user request, current work status, blockers, and unresolved follow-ups.',
].join(' ');

const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  keepRecentMessages: 3,
  compactRatio: 0.7,
  baseChunkRatio: 0.4,
  minChunkRatio: 0.15,
  safetyMargin: 1.2,
  maxSingleStageTokens: 50_000,
  minSummaryTokens: 180,
  maxSummaryTokens: 1_800,
  maxSummaryChars: 8_000,
};

export class NoCompactableMessagesError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} has no compactable messages.`);
    this.name = 'NoCompactableMessagesError';
  }
}

export interface CompactionBackend {
  deleteMessagesByIds: (sessionId: string, messageIds: number[]) => number;
  storeSemanticMemory: (params: {
    sessionId: string;
    role: string;
    source?: string | null;
    scope?: string | null;
    metadata?: Record<string, unknown> | string | null;
    content: string;
    confidence?: number;
    embedding?: number[] | null;
    sourceMessageId?: number | null;
  }) => number;
  updateSessionSummary: (sessionId: string, summary: string) => void;
}

export interface CompactionPromptRunner {
  run(params: {
    session: Session;
    systemPrompt: string;
    userPrompt: string;
    stageKind: CompactionStage['kind'];
    stageIndex: number;
    stageTotal: number;
  }): Promise<string>;
}

export interface ConversationSplit {
  system: StoredMessage[];
  compactable: StoredMessage[];
  recent: StoredMessage[];
}

export interface CompactConversationParams {
  session: Session;
  messages: StoredMessage[];
  backend: CompactionBackend;
  promptRunner: CompactionPromptRunner;
  embed?: (text: string) => number[] | null;
  config?: Partial<CompactionConfig>;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeStoredMessageRole(role: string): ChatMessage['role'] {
  if (
    role === 'system' ||
    role === 'user' ||
    role === 'assistant' ||
    role === 'tool'
  ) {
    return role;
  }
  return 'user';
}

function toChatMessages(messages: StoredMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    role: normalizeStoredMessageRole(message.role),
    content: message.content,
  }));
}

function estimateMessageTokens(message: StoredMessage): number {
  return estimateTokenCountFromMessages([
    {
      role: normalizeStoredMessageRole(message.role),
      content: message.content,
    },
  ]);
}

function resolveCompactionConfig(
  overrides?: Partial<CompactionConfig>,
): CompactionConfig {
  return {
    ...DEFAULT_COMPACTION_CONFIG,
    ...(overrides || {}),
  };
}

function normalizeSummary(text: string, maxChars: number): string {
  let normalized = text.trim();
  if (normalized.startsWith('```')) {
    normalized = normalized
      .replace(/^```[a-z0-9_-]*\s*/i, '')
      .replace(/```$/i, '')
      .trim();
  }
  if (normalized.length > maxChars) {
    normalized = `${normalized.slice(0, maxChars)}\n\n...[truncated]`;
  }
  return normalized.trim();
}

function formatStoredMessagesForPrompt(messages: StoredMessage[]): string {
  return messages
    .map((message) => {
      const username = message.username?.trim()
        ? ` username=${JSON.stringify(message.username)}`
        : '';
      return [
        `---`,
        `id=${message.id} role=${normalizeStoredMessageRole(message.role)} created_at=${message.created_at}${username}`,
        message.content.trim() || '(empty)',
      ].join('\n');
    })
    .join('\n');
}

function buildStructuredSystemPrompt(params: {
  targetTokens: number;
  stageKind: CompactionStage['kind'];
}): string {
  const sections = STRUCTURED_SUMMARY_SECTIONS.map(
    (section) => `## ${section}`,
  );
  const stageDirective =
    params.stageKind === 'merge'
      ? MERGE_SUMMARY_INSTRUCTIONS
      : 'Summarize the supplied conversation region.';
  return [
    'You are compacting conversation history for a long-running AI session.',
    stageDirective,
    IDENTIFIER_PRESERVATION_INSTRUCTIONS,
    'Keep durable facts, active work state, decisions, constraints, and open follow-ups.',
    'Drop greetings, filler, and low-value repetition.',
    `Keep the result under approximately ${params.targetTokens} tokens.`,
    'Return markdown only with these exact sections:',
    ...sections,
  ].join('\n');
}

function buildSummaryPrompt(params: {
  messages: StoredMessage[];
  previousSummary?: string | null;
  stageKind: CompactionStage['kind'];
}): string {
  const previousSummary = params.previousSummary?.trim() || '(none)';
  const stageLabel =
    params.stageKind === 'merge'
      ? 'Partial summaries to merge:'
      : 'Conversation messages to compact:';
  return [
    'Existing summary:',
    previousSummary,
    '',
    stageLabel,
    formatStoredMessagesForPrompt(params.messages),
    '',
    'Return a single updated summary that replaces the existing summary.',
  ].join('\n');
}

function computeTargetSummaryTokens(
  inputTokens: number,
  stageKind: CompactionStage['kind'],
  config: CompactionConfig,
): number {
  const retainedRatio = clamp(1 - config.compactRatio, 0.1, 0.8);
  const minTokens =
    stageKind === 'merge'
      ? Math.max(config.minSummaryTokens, 240)
      : config.minSummaryTokens;
  const maxTokens =
    stageKind === 'merge'
      ? Math.max(config.maxSummaryTokens, 2_200)
      : config.maxSummaryTokens;
  const raw = Math.floor(inputTokens * retainedRatio);
  return clamp(raw, minTokens, maxTokens);
}

function resolveContextWindowTokens(session: Session): number {
  const model = session.model?.trim() || '';
  return resolveModelContextWindowFallback(model) || 128_000;
}

function resolveMaxChunkTokens(params: {
  messages: StoredMessage[];
  session: Session;
  config: CompactionConfig;
}): number {
  const contextWindow = resolveContextWindowTokens(params.session);
  const ratio = computeAdaptiveChunkRatio(params.messages, contextWindow, {
    baseChunkRatio: params.config.baseChunkRatio,
    minChunkRatio: params.config.minChunkRatio,
    safetyMargin: params.config.safetyMargin,
  });
  const shareLimit = Math.floor(
    (contextWindow * ratio) / params.config.safetyMargin,
  );
  return clamp(
    Math.min(params.config.maxSingleStageTokens, shareLimit),
    1_000,
    params.config.maxSingleStageTokens,
  );
}

function isOversizedForSummary(
  message: StoredMessage,
  contextWindowTokens: number,
  config: CompactionConfig,
): boolean {
  return (
    estimateMessageTokens(message) * config.safetyMargin >
    contextWindowTokens * 0.5
  );
}

async function runSummaryAttempt(params: {
  session: Session;
  promptRunner: CompactionPromptRunner;
  messages: StoredMessage[];
  targetTokens: number;
  previousSummary?: string | null;
  stageKind: CompactionStage['kind'];
  stageIndex: number;
  stageTotal: number;
  maxSummaryChars: number;
}): Promise<string> {
  const result = await params.promptRunner.run({
    session: params.session,
    systemPrompt: buildStructuredSystemPrompt({
      targetTokens: params.targetTokens,
      stageKind: params.stageKind,
    }),
    userPrompt: buildSummaryPrompt({
      messages: params.messages,
      previousSummary: params.previousSummary,
      stageKind: params.stageKind,
    }),
    stageKind: params.stageKind,
    stageIndex: params.stageIndex,
    stageTotal: params.stageTotal,
  });
  const normalized = normalizeSummary(result, params.maxSummaryChars);
  if (!normalized) {
    throw new Error('Compaction summary was empty.');
  }
  return normalized;
}

function splitConversation(
  messages: StoredMessage[],
  overrides?: Partial<CompactionConfig>,
): ConversationSplit {
  const config = resolveCompactionConfig(overrides);
  const system = messages.filter((message) => message.role === 'system');
  const nonSystem = messages.filter((message) => message.role !== 'system');
  if (nonSystem.length <= config.keepRecentMessages) {
    return {
      system,
      compactable: [],
      recent: nonSystem,
    };
  }

  const totalTokens = estimateTokenCountFromMessages(toChatMessages(nonSystem));
  const minRecentCount = clamp(config.keepRecentMessages, 1, nonSystem.length);
  const minimumRecentTokens = estimateTokenCountFromMessages(
    toChatMessages(nonSystem.slice(-minRecentCount)),
  );
  const targetRecentTokens = Math.max(
    minimumRecentTokens,
    Math.floor(totalTokens * clamp(1 - config.compactRatio, 0.1, 0.8)),
  );

  let recentStart = nonSystem.length;
  let keptRecentCount = 0;
  let keptRecentTokens = 0;
  while (recentStart > 0) {
    recentStart -= 1;
    keptRecentCount += 1;
    keptRecentTokens += estimateMessageTokens(nonSystem[recentStart]);
    if (
      keptRecentCount >= minRecentCount &&
      keptRecentTokens >= targetRecentTokens
    ) {
      break;
    }
  }

  return {
    system,
    compactable: nonSystem.slice(0, recentStart),
    recent: nonSystem.slice(recentStart),
  };
}

export function splitMessagesByTokenShare(
  messages: StoredMessage[],
  parts: number,
): StoredMessage[][] {
  if (messages.length === 0) return [];
  const normalizedParts = clamp(Math.floor(parts) || 1, 1, messages.length);
  if (normalizedParts <= 1) return [messages];

  const totalTokens = estimateTokenCountFromMessages(toChatMessages(messages));
  const targetTokens = totalTokens / normalizedParts;
  const chunks: StoredMessage[][] = [];
  let current: StoredMessage[] = [];
  let currentTokens = 0;

  for (const message of messages) {
    const messageTokens = estimateMessageTokens(message);
    if (
      chunks.length < normalizedParts - 1 &&
      current.length > 0 &&
      currentTokens + messageTokens > targetTokens
    ) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(message);
    currentTokens += messageTokens;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

export function computeAdaptiveChunkRatio(
  messages: StoredMessage[],
  contextWindowTokens: number,
  overrides?: Pick<
    CompactionConfig,
    'baseChunkRatio' | 'minChunkRatio' | 'safetyMargin'
  >,
): number {
  if (messages.length === 0) {
    return (
      overrides?.baseChunkRatio ?? DEFAULT_COMPACTION_CONFIG.baseChunkRatio
    );
  }

  const baseChunkRatio =
    overrides?.baseChunkRatio ?? DEFAULT_COMPACTION_CONFIG.baseChunkRatio;
  const minChunkRatio =
    overrides?.minChunkRatio ?? DEFAULT_COMPACTION_CONFIG.minChunkRatio;
  const safetyMargin =
    overrides?.safetyMargin ?? DEFAULT_COMPACTION_CONFIG.safetyMargin;

  const totalTokens = estimateTokenCountFromMessages(toChatMessages(messages));
  const avgTokens = totalTokens / messages.length;
  const safeAvgTokens = avgTokens * safetyMargin;
  const avgRatio = safeAvgTokens / Math.max(1, contextWindowTokens);

  if (avgRatio > 0.1) {
    const reduction = Math.min(avgRatio * 2, baseChunkRatio - minChunkRatio);
    return Math.max(minChunkRatio, baseChunkRatio - reduction);
  }

  return baseChunkRatio;
}

export async function summarizeWithFallback(params: {
  session: Session;
  promptRunner: CompactionPromptRunner;
  messages: StoredMessage[];
  previousSummary?: string | null;
  targetTokens: number;
  stageKind: CompactionStage['kind'];
  stageIndex: number;
  stageTotal: number;
  config: CompactionConfig;
}): Promise<string> {
  const ratios = [1, 0.7, 0.5];
  let lastError: unknown = null;
  let bestSummary = '';

  for (const ratio of ratios) {
    try {
      const summary = await runSummaryAttempt({
        session: params.session,
        promptRunner: params.promptRunner,
        messages: params.messages,
        targetTokens: clamp(
          Math.floor(params.targetTokens * ratio),
          params.config.minSummaryTokens,
          Math.max(params.config.maxSummaryTokens, params.targetTokens),
        ),
        previousSummary: params.previousSummary,
        stageKind: params.stageKind,
        stageIndex: params.stageIndex,
        stageTotal: params.stageTotal,
        maxSummaryChars: params.config.maxSummaryChars,
      });
      bestSummary = summary;
      const estimatedTokens = estimateTokenCountFromText(summary);
      if (
        estimatedTokens <=
        Math.ceil(params.targetTokens * params.config.safetyMargin)
      ) {
        return summary;
      }
    } catch (err) {
      lastError = err;
    }
  }

  if (bestSummary) return bestSummary;

  const contextWindowTokens = resolveContextWindowTokens(params.session);
  const smallMessages: StoredMessage[] = [];
  const oversizedNotes: string[] = [];

  for (const message of params.messages) {
    if (isOversizedForSummary(message, contextWindowTokens, params.config)) {
      oversizedNotes.push(
        `[Large ${normalizeStoredMessageRole(message.role)} message id=${message.id} omitted from summary due to size limits]`,
      );
    } else {
      smallMessages.push(message);
    }
  }

  if (smallMessages.length > 0) {
    try {
      const summary = await runSummaryAttempt({
        session: params.session,
        promptRunner: params.promptRunner,
        messages: smallMessages,
        targetTokens: params.targetTokens,
        previousSummary: params.previousSummary,
        stageKind: params.stageKind,
        stageIndex: params.stageIndex,
        stageTotal: params.stageTotal,
        maxSummaryChars: params.config.maxSummaryChars,
      });
      return oversizedNotes.length > 0
        ? normalizeSummary(
            `${summary}\n\n## Key Context\n${oversizedNotes.join('\n')}`,
            params.config.maxSummaryChars,
          )
        : summary;
    } catch (err) {
      lastError = err;
    }
  }

  logger.warn(
    {
      sessionId: params.session.id,
      stageKind: params.stageKind,
      stageIndex: params.stageIndex,
      err: lastError,
    },
    'Compaction summary fallback exhausted',
  );

  return normalizeSummary(
    [
      '## Goals',
      '- Summary unavailable due to compaction size limits.',
      '',
      '## Constraints',
      '- Preserve archived transcript for full fidelity.',
      '',
      '## Progress',
      `- ${params.messages.length} messages were selected for compaction.`,
      '',
      '## Key Decisions',
      '- No reliable summary could be generated automatically.',
      '',
      '## Next Steps',
      '- Review the archive if full transcript details are required.',
      '',
      '## Key Context',
      '- Large or malformed message payloads prevented a stable summary.',
    ].join('\n'),
    params.config.maxSummaryChars,
  );
}

async function summarizeInStages(params: {
  session: Session;
  promptRunner: CompactionPromptRunner;
  messages: StoredMessage[];
  previousSummary?: string | null;
  config: CompactionConfig;
}): Promise<{ summary: string; stages: CompactionStage[] }> {
  const totalTokens = estimateTokenCountFromMessages(
    toChatMessages(params.messages),
  );
  const maxChunkTokens = resolveMaxChunkTokens({
    messages: params.messages,
    session: params.session,
    config: params.config,
  });
  const stages: CompactionStage[] = [];

  if (totalTokens <= maxChunkTokens) {
    const targetTokens = computeTargetSummaryTokens(
      totalTokens,
      'single',
      params.config,
    );
    const summary = await summarizeWithFallback({
      session: params.session,
      promptRunner: params.promptRunner,
      messages: params.messages,
      previousSummary: params.previousSummary,
      targetTokens,
      stageKind: 'single',
      stageIndex: 0,
      stageTotal: 1,
      config: params.config,
    });
    stages.push({
      kind: 'single',
      index: 0,
      total: 1,
      inputTokens: totalTokens,
      outputTokens: estimateTokenCountFromText(summary),
      messageCount: params.messages.length,
    });
    return { summary, stages };
  }

  const parts = Math.max(2, Math.ceil(totalTokens / maxChunkTokens));
  const chunks = splitMessagesByTokenShare(params.messages, parts).filter(
    (chunk) => chunk.length > 0,
  );
  const partialSummaries: string[] = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const chunkTokens = estimateTokenCountFromMessages(toChatMessages(chunk));
    const summary = await summarizeWithFallback({
      session: params.session,
      promptRunner: params.promptRunner,
      messages: chunk,
      targetTokens: computeTargetSummaryTokens(
        chunkTokens,
        'part',
        params.config,
      ),
      stageKind: 'part',
      stageIndex: index,
      stageTotal: chunks.length,
      config: params.config,
    });
    partialSummaries.push(summary);
    stages.push({
      kind: 'part',
      index,
      total: chunks.length,
      inputTokens: chunkTokens,
      outputTokens: estimateTokenCountFromText(summary),
      messageCount: chunk.length,
    });
  }

  if (partialSummaries.length === 1) {
    return { summary: partialSummaries[0], stages };
  }

  const mergeMessages = partialSummaries.map<StoredMessage>(
    (summary, index) => ({
      id: -1 - index,
      session_id: params.session.id,
      user_id: 'compaction',
      username: null,
      role: 'assistant',
      content: summary,
      created_at: new Date().toISOString(),
    }),
  );
  const mergeInputTokens = estimateTokenCountFromMessages(
    toChatMessages(mergeMessages),
  );
  const mergedSummary = await summarizeWithFallback({
    session: params.session,
    promptRunner: params.promptRunner,
    messages: mergeMessages,
    previousSummary: params.previousSummary,
    targetTokens: computeTargetSummaryTokens(
      mergeInputTokens,
      'merge',
      params.config,
    ),
    stageKind: 'merge',
    stageIndex: 0,
    stageTotal: 1,
    config: params.config,
  });
  stages.push({
    kind: 'merge',
    index: 0,
    total: 1,
    inputTokens: mergeInputTokens,
    outputTokens: estimateTokenCountFromText(mergedSummary),
    messageCount: mergeMessages.length,
  });
  return { summary: mergedSummary, stages };
}

export async function compactConversation(
  params: CompactConversationParams,
): Promise<CompactionResult> {
  const startedAt = Date.now();
  const config = resolveCompactionConfig(params.config);
  const split = splitConversation(params.messages, config);
  if (split.compactable.length === 0) {
    throw new NoCompactableMessagesError(params.session.id);
  }

  const archive = archiveTranscript({
    sessionId: params.session.id,
    messages: params.messages,
    baseDir: config.archiveBaseDir,
  });
  const previousSummary = params.session.session_summary?.trim() || null;
  const { summary, stages } = await summarizeInStages({
    session: params.session,
    promptRunner: params.promptRunner,
    messages: split.compactable,
    previousSummary,
    config,
  });

  const normalizedSummary = normalizeSummary(summary, config.maxSummaryChars);
  const tokensBefore = estimateTokenCountFromMessages(
    toChatMessages(params.messages),
  );
  const metadata = {
    archivePath: archive.path,
    tokensBefore,
    stages: stages.length,
    compactedMessages: split.compactable.length,
    preservedMessages: split.system.length + split.recent.length,
  };

  params.backend.storeSemanticMemory({
    sessionId: params.session.id,
    role: 'assistant',
    source: 'compaction',
    scope: 'session',
    metadata,
    content: normalizedSummary,
    confidence: 0.95,
    embedding: params.embed ? params.embed(normalizedSummary) : null,
    sourceMessageId: null,
  });
  params.backend.updateSessionSummary(params.session.id, normalizedSummary);

  const deleted = params.backend.deleteMessagesByIds(
    params.session.id,
    split.compactable.map((message) => message.id),
  );
  if (deleted !== split.compactable.length) {
    logger.warn(
      {
        sessionId: params.session.id,
        expected: split.compactable.length,
        deleted,
      },
      'Compaction deleted an unexpected number of messages',
    );
  }

  const tokensAfter =
    estimateTokenCountFromMessages(
      toChatMessages([...split.system, ...split.recent]),
    ) + estimateTokenCountFromText(normalizedSummary);

  return {
    tokensBefore,
    tokensAfter,
    messagesCompacted: deleted,
    messagesPreserved: split.system.length + split.recent.length,
    archivePath: archive.path,
    durationMs: Math.max(0, Date.now() - startedAt),
    stages,
  };
}
