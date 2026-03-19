import { resolveAgentForRequest } from '../agents/agent-registry.js';
import { SESSION_COMPACTION_SUMMARY_MAX_CHARS } from '../config/config.js';
import { callAuxiliaryModel } from '../providers/auxiliary.js';
import type {
  SessionExpiryEvaluation,
  SessionResetPolicy,
} from '../session/session-reset.js';
import type {
  CanonicalSession,
  CanonicalSessionContext,
  CompactionResult,
  KnowledgeEntityTypeValue,
  KnowledgeGraphMatch,
  KnowledgeGraphPattern,
  KnowledgeRelationTypeValue,
  MemoryCitation,
  SemanticMemoryEntry,
  Session,
  StoredMessage,
  StructuredMemoryEntry,
} from '../types.js';
import { compactConversation } from './compaction.js';
import {
  addKnowledgeEntity as dbAddKnowledgeEntity,
  addKnowledgeRelation as dbAddKnowledgeRelation,
  appendCanonicalMessages as dbAppendCanonicalMessages,
  clearCanonicalContext as dbClearCanonicalContext,
  clearSessionHistory as dbClearSessionHistory,
  deleteMemoryValue as dbDeleteMemoryValue,
  deleteMessagesBeforeId as dbDeleteMessagesBeforeId,
  deleteMessagesByIds as dbDeleteMessagesByIds,
  forgetSemanticMemory as dbForgetSemanticMemory,
  getCanonicalContext as dbGetCanonicalContext,
  getCompactionCandidateMessages as dbGetCompactionCandidateMessages,
  getConversationHistory as dbGetConversationHistory,
  getMemoryValue as dbGetMemoryValue,
  getOrCreateSession as dbGetOrCreateSession,
  getRecentMessages as dbGetRecentMessages,
  getSessionById as dbGetSessionById,
  listMemoryValues as dbListMemoryValues,
  markSessionMemoryFlush as dbMarkSessionMemoryFlush,
  queryKnowledgeGraph as dbQueryKnowledgeGraph,
  recallSemanticMemories as dbRecallSemanticMemories,
  resetSessionIfExpired as dbResetSessionIfExpired,
  setMemoryValue as dbSetMemoryValue,
  storeMessage as dbStoreMessage,
  storeSemanticMemory as dbStoreSemanticMemory,
  updateSessionSummary as dbUpdateSessionSummary,
  decaySemanticMemories,
  type SemanticRecallFilter,
} from './db.js';
import {
  type MemoryConsolidationConfig,
  MemoryConsolidationEngine,
  type MemoryConsolidationReport,
} from './memory-consolidation.js';

export interface CompactionCandidate {
  cutoffId: number;
  olderMessages: StoredMessage[];
}

export interface MemoryBackend {
  resetSessionIfExpired: (
    sessionId: string,
    opts: {
      policy: SessionResetPolicy;
      expiryEvaluation?: SessionExpiryEvaluation;
    },
  ) => Session | null;
  getOrCreateSession: (
    sessionId: string,
    guildId: string | null,
    channelId: string,
    agentId?: string,
    options?: {
      forceNewCurrent?: boolean;
    },
  ) => Session;
  getSessionById: (sessionId: string) => Session | undefined;
  getConversationHistory: (
    sessionId: string,
    limit?: number,
  ) => StoredMessage[];
  getRecentMessages: (sessionId: string, limit?: number) => StoredMessage[];
  get: (sessionId: string, key: string) => unknown | null;
  set: (sessionId: string, key: string, value: unknown) => void;
  delete: (sessionId: string, key: string) => boolean;
  list: (sessionId: string, prefix?: string) => StructuredMemoryEntry[];
  appendCanonicalMessages: (params: {
    agentId: string;
    userId: string;
    newMessages: Array<{
      role: string;
      content: string;
      sessionId: string;
      channelId?: string | null;
      createdAt?: string | null;
    }>;
    windowSize?: number;
    compactionThreshold?: number;
  }) => CanonicalSession;
  getCanonicalContext: (params: {
    agentId: string;
    userId: string;
    windowSize?: number;
    excludeSessionId?: string | null;
  }) => CanonicalSessionContext;
  clearCanonicalContext?: (params: {
    agentId: string;
    userId: string;
  }) => number;
  addKnowledgeEntity: (params: {
    id?: string | null;
    name: string;
    entityType: KnowledgeEntityTypeValue | string;
    properties?: Record<string, unknown> | null;
  }) => string;
  addKnowledgeRelation: (params: {
    source: string;
    relation: KnowledgeRelationTypeValue | string;
    target: string;
    properties?: Record<string, unknown> | null;
    confidence?: number;
  }) => string;
  queryKnowledgeGraph: (
    pattern?: KnowledgeGraphPattern,
  ) => KnowledgeGraphMatch[];
  getCompactionCandidateMessages: (
    sessionId: string,
    keepRecent: number,
  ) => CompactionCandidate | null;
  storeMessage: (
    sessionId: string,
    userId: string,
    username: string | null,
    role: string,
    content: string,
  ) => number;
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
  recallSemanticMemories: (params: {
    sessionId: string;
    query: string;
    limit?: number;
    minConfidence?: number;
    queryEmbedding?: number[] | null;
    filter?: SemanticRecallFilter;
  }) => SemanticMemoryEntry[];
  forgetSemanticMemory: (id: number) => boolean;
  decaySemanticMemories: (params?: {
    decayRate?: number;
    staleAfterDays?: number;
    minConfidence?: number;
  }) => number;
  clearSessionHistory: (sessionId: string) => number;
  deleteMessagesBeforeId: (sessionId: string, cutoffId: number) => number;
  deleteMessagesByIds: (sessionId: string, messageIds: number[]) => number;
  updateSessionSummary: (sessionId: string, summary: string) => void;
  markSessionMemoryFlush: (sessionId: string) => void;
}

export interface MemoryServiceConfig {
  semanticRecallLimit: number;
  semanticMinConfidence: number;
  semanticMaxContentChars: number;
  semanticDecayRate: number;
  semanticDecayStaleAfterDays: number;
  semanticDecayMinConfidence: number;
  summaryDecayRate: number;
  summaryMinConfidence: number;
  summaryDiscardThreshold: number;
  embeddingDimensions: number;
}

export interface EmbeddingProvider {
  embed(text: string): number[] | null;
}

export interface StoreTurnParams {
  sessionId: string;
  user: {
    userId: string;
    username: string | null;
    content: string;
  };
  assistant: {
    userId?: string;
    username?: string | null;
    content: string;
  };
}

export interface BuildMemoryPromptParams {
  session: Session;
  query: string;
  semanticLimit?: number;
}

export interface BuildMemoryPromptResult {
  promptSummary: string | null;
  summaryConfidence: number | null;
  semanticMemories: SemanticMemoryEntry[];
  citationIndex: MemoryCitation[];
}

export interface RecallSemanticMemoriesParams {
  sessionId: string;
  query: string;
  limit?: number;
  minConfidence?: number;
  filter?: SemanticRecallFilter;
}

const DEFAULT_CONFIG: MemoryServiceConfig = {
  semanticRecallLimit: 5,
  semanticMinConfidence: 0.2,
  semanticMaxContentChars: 1_200,
  semanticDecayRate: 0.1,
  semanticDecayStaleAfterDays: 7,
  semanticDecayMinConfidence: 0.1,
  summaryDecayRate: 0.04,
  summaryMinConfidence: 0.1,
  summaryDiscardThreshold: 0.22,
  embeddingDimensions: 128,
};

const DEFAULT_BACKEND: MemoryBackend = {
  resetSessionIfExpired: dbResetSessionIfExpired,
  getOrCreateSession: dbGetOrCreateSession,
  getSessionById: dbGetSessionById,
  getConversationHistory: dbGetConversationHistory,
  getRecentMessages: dbGetRecentMessages,
  get: dbGetMemoryValue,
  set: dbSetMemoryValue,
  delete: dbDeleteMemoryValue,
  list: dbListMemoryValues,
  appendCanonicalMessages: dbAppendCanonicalMessages,
  getCanonicalContext: dbGetCanonicalContext,
  clearCanonicalContext: dbClearCanonicalContext,
  addKnowledgeEntity: dbAddKnowledgeEntity,
  addKnowledgeRelation: dbAddKnowledgeRelation,
  queryKnowledgeGraph: dbQueryKnowledgeGraph,
  getCompactionCandidateMessages: dbGetCompactionCandidateMessages,
  storeMessage: dbStoreMessage,
  storeSemanticMemory: dbStoreSemanticMemory,
  recallSemanticMemories: dbRecallSemanticMemories,
  forgetSemanticMemory: dbForgetSemanticMemory,
  decaySemanticMemories,
  clearSessionHistory: dbClearSessionHistory,
  deleteMessagesBeforeId: dbDeleteMessagesBeforeId,
  deleteMessagesByIds: dbDeleteMessagesByIds,
  updateSessionSummary: dbUpdateSessionSummary,
  markSessionMemoryFlush: dbMarkSessionMemoryFlush,
};

function parseTimestamp(raw: string | null | undefined): number | null {
  const value = (raw || '').trim();
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    const parsed = Date.parse(`${value.replace(' ', 'T')}Z`);
    return Number.isNaN(parsed) ? null : parsed;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function computeDecayedConfidence(params: {
  updatedAt: string | null | undefined;
  decayRate: number;
  minConfidence: number;
  nowMs?: number;
}): number {
  const updatedMs = parseTimestamp(params.updatedAt);
  if (updatedMs == null) return 1;

  const nowMs =
    typeof params.nowMs === 'number' && Number.isFinite(params.nowMs)
      ? params.nowMs
      : Date.now();
  const ageDays = Math.max(0, (nowMs - updatedMs) / 86_400_000);
  const decayRate = Math.max(0, Math.min(0.95, params.decayRate));
  const minConfidence = Math.max(0, Math.min(0.95, params.minConfidence));
  const decayed = (1 - decayRate) ** ageDays;
  return Math.max(minConfidence, Math.min(1, decayed));
}

function truncateInline(content: string, maxChars: number): string {
  const compact = content.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars)}...`;
}

class HashedTokenEmbeddingProvider implements EmbeddingProvider {
  private readonly dimensions: number;

  constructor(dimensions: number) {
    this.dimensions = Math.max(16, Math.min(1024, Math.floor(dimensions)));
  }

  embed(text: string): number[] | null {
    const normalized = text
      .toLowerCase()
      .replace(/[^a-z0-9_\s-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!normalized) return null;

    const tokens = normalized
      .split(' ')
      .map((token) => token.trim())
      .filter((token) => token.length > 1)
      .slice(0, 256);
    if (tokens.length === 0) return null;

    const vector = new Float32Array(this.dimensions);
    for (const token of tokens) {
      const hash = this.hashToken(token);
      const index = hash % this.dimensions;
      const sign = (hash & 1) === 0 ? 1 : -1;
      vector[index] += sign * Math.min(4, token.length);
    }

    let norm = 0;
    for (let i = 0; i < vector.length; i += 1) {
      norm += vector[i] * vector[i];
    }
    if (norm <= Number.EPSILON) return null;
    const scale = 1 / Math.sqrt(norm);
    return Array.from(vector, (value) => value * scale);
  }

  private hashToken(token: string): number {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i += 1) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }
}

export class MemoryService {
  private readonly backend: MemoryBackend;
  private readonly config: MemoryServiceConfig;
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly consolidationEngine: MemoryConsolidationEngine;
  private readonly compactionLocks = new Map<
    string,
    Promise<CompactionResult>
  >();

  constructor(
    backend: MemoryBackend = DEFAULT_BACKEND,
    config?: Partial<MemoryServiceConfig>,
    embeddingProvider?: EmbeddingProvider,
  ) {
    this.backend = backend;
    this.config = { ...DEFAULT_CONFIG, ...(config || {}) };
    this.embeddingProvider =
      embeddingProvider ||
      new HashedTokenEmbeddingProvider(this.config.embeddingDimensions);
    this.consolidationEngine = new MemoryConsolidationEngine(this.backend, {
      decayRate: this.config.semanticDecayRate,
      staleAfterDays: this.config.semanticDecayStaleAfterDays,
      minConfidence: this.config.semanticDecayMinConfidence,
    });
  }

  getOrCreateSession(
    sessionId: string,
    guildId: string | null,
    channelId: string,
    agentId?: string,
    options?: {
      forceNewCurrent?: boolean;
    },
  ): Session {
    return this.backend.getOrCreateSession(
      sessionId,
      guildId,
      channelId,
      agentId,
      options,
    );
  }

  resetSessionIfExpired(
    sessionId: string,
    opts: {
      policy: SessionResetPolicy;
      expiryEvaluation?: SessionExpiryEvaluation;
    },
  ): Session | null {
    return this.backend.resetSessionIfExpired(sessionId, opts);
  }

  getSessionById(sessionId: string): Session | undefined {
    return this.backend.getSessionById(sessionId);
  }

  getConversationHistory(sessionId: string, limit = 50): StoredMessage[] {
    return this.backend.getConversationHistory(sessionId, limit);
  }

  getRecentMessages(sessionId: string, limit?: number): StoredMessage[] {
    return this.backend.getRecentMessages(sessionId, limit);
  }

  get(sessionId: string, key: string): unknown | null {
    return this.backend.get(sessionId, key);
  }

  set(sessionId: string, key: string, value: unknown): void {
    this.backend.set(sessionId, key, value);
  }

  delete(sessionId: string, key: string): boolean {
    return this.backend.delete(sessionId, key);
  }

  list(sessionId: string, prefix?: string): StructuredMemoryEntry[] {
    return this.backend.list(sessionId, prefix);
  }

  appendCanonicalMessages(params: {
    agentId: string;
    userId: string;
    newMessages: Array<{
      role: string;
      content: string;
      sessionId: string;
      channelId?: string | null;
      createdAt?: string | null;
    }>;
    windowSize?: number;
    compactionThreshold?: number;
  }): CanonicalSession {
    return this.backend.appendCanonicalMessages(params);
  }

  getCanonicalContext(params: {
    agentId: string;
    userId: string;
    windowSize?: number;
    excludeSessionId?: string | null;
  }): CanonicalSessionContext {
    return this.backend.getCanonicalContext(params);
  }

  clearCanonicalContext(params: { agentId: string; userId: string }): number {
    return this.backend.clearCanonicalContext?.(params) ?? 0;
  }

  addKnowledgeEntity(params: {
    id?: string | null;
    name: string;
    entityType: KnowledgeEntityTypeValue | string;
    properties?: Record<string, unknown> | null;
  }): string {
    return this.backend.addKnowledgeEntity(params);
  }

  addKnowledgeRelation(params: {
    source: string;
    relation: KnowledgeRelationTypeValue | string;
    target: string;
    properties?: Record<string, unknown> | null;
    confidence?: number;
  }): string {
    return this.backend.addKnowledgeRelation(params);
  }

  queryKnowledgeGraph(pattern?: KnowledgeGraphPattern): KnowledgeGraphMatch[] {
    return this.backend.queryKnowledgeGraph(pattern);
  }

  consolidateMemories(
    overrides?: Partial<MemoryConsolidationConfig>,
  ): MemoryConsolidationReport {
    return this.consolidationEngine.consolidate(overrides);
  }

  async compactSession(sessionId: string): Promise<CompactionResult> {
    const existing = this.compactionLocks.get(sessionId);
    if (existing) return existing;

    const promise = (async () => {
      const session = this.backend.getSessionById(sessionId);
      if (!session) {
        throw new Error(`Session ${sessionId} was not found.`);
      }

      const messages = this.backend.getRecentMessages(sessionId);
      return compactConversation({
        session,
        messages,
        backend: {
          deleteMessagesByIds: this.backend.deleteMessagesByIds,
          storeSemanticMemory: this.backend.storeSemanticMemory,
          updateSessionSummary: this.backend.updateSessionSummary,
        },
        promptRunner: {
          run: ({
            session: targetSession,
            systemPrompt,
            userPrompt,
            stageKind,
            stageIndex,
            stageTotal,
          }) =>
            this.runCompactionPrompt({
              session: targetSession,
              systemPrompt,
              userPrompt,
              stageKind,
              stageIndex,
              stageTotal,
            }),
        },
        embed: (text) => this.embeddingProvider.embed(text),
        config: {
          maxSummaryChars: SESSION_COMPACTION_SUMMARY_MAX_CHARS,
        },
      });
    })().finally(() => {
      this.compactionLocks.delete(sessionId);
    });

    this.compactionLocks.set(sessionId, promise);
    return promise;
  }

  recallSemanticMemories(
    params: RecallSemanticMemoriesParams,
  ): SemanticMemoryEntry[] {
    const limit = Math.max(
      1,
      Math.min(Math.floor(params.limit || this.config.semanticRecallLimit), 50),
    );
    const rawMinConfidence =
      typeof params.minConfidence === 'number' &&
      Number.isFinite(params.minConfidence)
        ? params.minConfidence
        : this.config.semanticMinConfidence;
    const minConfidence = Math.max(0, Math.min(1, rawMinConfidence));
    const query = params.query.trim();

    return this.backend.recallSemanticMemories({
      sessionId: params.sessionId,
      query,
      limit,
      minConfidence,
      queryEmbedding: this.embeddingProvider.embed(query),
      filter: params.filter,
    });
  }

  getCompactionCandidateMessages(
    sessionId: string,
    keepRecent: number,
  ): CompactionCandidate | null {
    return this.backend.getCompactionCandidateMessages(sessionId, keepRecent);
  }

  clearSessionHistory(sessionId: string): number {
    return this.backend.clearSessionHistory(sessionId);
  }

  deleteMessagesBeforeId(sessionId: string, cutoffId: number): number {
    return this.backend.deleteMessagesBeforeId(sessionId, cutoffId);
  }

  updateSessionSummary(sessionId: string, summary: string): void {
    this.backend.updateSessionSummary(sessionId, summary);
  }

  markSessionMemoryFlush(sessionId: string): void {
    this.backend.markSessionMemoryFlush(sessionId);
  }

  forgetSemanticMemory(id: number): boolean {
    return this.backend.forgetSemanticMemory(id);
  }

  storeMessage(params: {
    sessionId: string;
    userId: string;
    username: string | null;
    role: string;
    content: string;
  }): number {
    return this.backend.storeMessage(
      params.sessionId,
      params.userId,
      params.username,
      params.role,
      params.content,
    );
  }

  storeTurn(params: StoreTurnParams): void {
    this.storeMessage({
      sessionId: params.sessionId,
      userId: params.user.userId,
      username: params.user.username,
      role: 'user',
      content: params.user.content,
    });
    const assistantMessageId = this.storeMessage({
      sessionId: params.sessionId,
      userId: params.assistant.userId || 'assistant',
      username: params.assistant.username || null,
      role: 'assistant',
      content: params.assistant.content,
    });

    const interactionText = this.normalizeSemanticContent(
      `User asked: ${params.user.content.trim()}\nI responded: ${params.assistant.content.trim()}`,
    );
    if (!interactionText) return;

    this.backend.storeSemanticMemory({
      sessionId: params.sessionId,
      role: 'assistant',
      source: 'conversation',
      scope: 'episodic',
      metadata: {},
      content: interactionText,
      confidence: 1,
      embedding: this.embeddingProvider.embed(interactionText),
      sourceMessageId: assistantMessageId,
    });
  }

  buildPromptMemoryContext(
    params: BuildMemoryPromptParams,
  ): BuildMemoryPromptResult {
    const summaryText = (params.session.session_summary || '').trim();
    const summaryConfidence = summaryText
      ? computeDecayedConfidence({
          updatedAt: params.session.summary_updated_at,
          decayRate: this.config.summaryDecayRate,
          minConfidence: this.config.summaryMinConfidence,
        })
      : null;

    const includeSummary =
      summaryText &&
      (summaryConfidence == null ||
        summaryConfidence >= this.config.summaryDiscardThreshold);

    const semanticLimit = Math.max(
      1,
      Math.min(
        Math.floor(params.semanticLimit || this.config.semanticRecallLimit),
        12,
      ),
    );
    const semanticMemories = this.recallSemanticMemories({
      sessionId: params.session.id,
      query: params.query,
      limit: semanticLimit,
      minConfidence: this.config.semanticMinConfidence,
    });
    const citationIndex: MemoryCitation[] = semanticMemories.map(
      (memory, i) => ({
        ref: `[mem:${i + 1}]`,
        memoryId: memory.id,
        content: truncateInline(memory.content, 220),
        confidence: Math.max(0, Math.min(1, memory.confidence)),
      }),
    );

    const sections: string[] = [];
    if (includeSummary) {
      if (summaryConfidence != null && summaryConfidence < 0.999) {
        sections.push(
          `Summary confidence: ${Math.round(summaryConfidence * 100)}% (decayed by age).`,
        );
      }
      sections.push(summaryText);
    }

    if (semanticMemories.length > 0) {
      const lines = citationIndex.map((citation) => {
        const confidence = Math.round(citation.confidence * 100);
        return `- ${citation.ref} (${confidence}%) ${citation.content}`;
      });
      sections.push(
        [
          '### Relevant Memory Recall',
          'Topic-matched context from older turns (vector cosine search).',
          'If you use any of these memories in your response, cite them inline using their tag (e.g. [mem:1]).',
          ...lines,
        ].join('\n'),
      );
    }

    const promptSummary = sections.join('\n\n').trim();
    return {
      promptSummary: promptSummary || null,
      summaryConfidence,
      semanticMemories,
      citationIndex,
    };
  }

  private normalizeSemanticContent(content: string): string {
    const compact = content.replace(/\s+/g, ' ').trim();
    if (compact.length <= this.config.semanticMaxContentChars) return compact;
    return compact.slice(0, this.config.semanticMaxContentChars);
  }

  private async runCompactionPrompt(params: {
    session: Session;
    systemPrompt: string;
    userPrompt: string;
    stageKind: 'single' | 'part' | 'merge';
    stageIndex: number;
    stageTotal: number;
  }): Promise<string> {
    const { agentId, model, chatbotId } = resolveAgentForRequest({
      session: params.session,
    });
    const result = await callAuxiliaryModel({
      task: 'compression',
      agentId,
      fallbackModel: model,
      fallbackChatbotId: chatbotId,
      fallbackEnableRag: params.session.enable_rag !== 0,
      messages: [
        { role: 'system', content: params.systemPrompt },
        { role: 'user', content: params.userPrompt },
      ],
    });

    if (!result.content.trim()) {
      throw new Error('Compaction prompt returned no summary.');
    }
    return result.content;
  }
}

export const memoryService = new MemoryService();
