import { resolveAgentForRequest } from '../agents/agent-registry.js';
import { SESSION_COMPACTION_SUMMARY_MAX_CHARS } from '../config/config.js';
import { getRuntimeConfig } from '../config/runtime-config.js';
import { callAuxiliaryModel } from '../providers/auxiliary.js';
import type {
  SessionExpiryEvaluation,
  SessionResetPolicy,
} from '../session/session-reset.js';
import type {
  KnowledgeEntityTypeValue,
  KnowledgeGraphMatch,
  KnowledgeGraphPattern,
  KnowledgeRelationTypeValue,
} from '../types/knowledge.js';
import type {
  CompactionResult,
  MemoryCitation,
  SemanticMemoryEntry,
  StructuredMemoryEntry,
} from '../types/memory.js';
import type {
  CanonicalSession,
  CanonicalSessionContext,
  ConversationBranchFamily,
  ConversationHistoryPage,
  ForkSessionBranchParams,
  ForkSessionBranchResult,
  Session,
  StoredMessage,
} from '../types/session.js';
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
  forkSessionBranch as dbForkSessionBranch,
  getCanonicalContext as dbGetCanonicalContext,
  getCompactionCandidateMessages as dbGetCompactionCandidateMessages,
  getConversationBranchFamilies as dbGetConversationBranchFamilies,
  getConversationHistory as dbGetConversationHistory,
  getConversationHistoryPage as dbGetConversationHistoryPage,
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
  getDefaultMemoryEmbeddingCacheDir,
  type MemoryEmbeddingProviderKind,
  normalizeMemoryEmbeddingProviderKind,
} from './embeddings.js';
import {
  MemoryConsolidationEngine,
  type MemoryConsolidationReport,
} from './memory-consolidation.js';
import {
  type MemoryQueryMode,
  type MemoryRecallBackend,
  type MemoryRecallRerank,
  type MemoryRecallTokenizer,
  normalizeMemoryRecallBackend,
  prepareMemoryRecallQuery,
} from './semantic-recall.js';
import { TransformersJsEmbeddingProvider } from './transformers-embedding-provider.js';

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
  getConversationHistoryPage: (
    sessionId: string,
    limit?: number,
  ) => ConversationHistoryPage;
  getConversationBranchFamilies: (
    sessionId: string,
  ) => ConversationBranchFamily[];
  getRecentMessages: (sessionId: string, limit?: number) => StoredMessage[];
  forkSessionBranch: (
    params: ForkSessionBranchParams,
  ) => ForkSessionBranchResult;
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
    limitHardCap?: number | null;
    minConfidence?: number;
    queryEmbedding?: number[] | null;
    backend?: MemoryRecallBackend;
    rerank?: MemoryRecallRerank;
    tokenizer?: MemoryRecallTokenizer;
    filter?: SemanticRecallFilter;
    touch?: boolean;
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
  semanticPromptHardCap: number;
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
  embed?(text: string): number[] | null;
  embedQuery?(text: string): number[] | null;
  embedDocument?(text: string): number[] | null;
  warmup?(): void;
  dispose?(): void;
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
  touchSemanticRecall?: boolean;
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
  limitHardCap?: number | null;
  minConfidence?: number;
  queryMode?: MemoryQueryMode;
  backend?: MemoryRecallBackend;
  rerank?: MemoryRecallRerank;
  tokenizer?: MemoryRecallTokenizer;
  embeddingProvider?: MemoryEmbeddingProviderKind;
  filter?: SemanticRecallFilter;
  touch?: boolean;
}

const DEFAULT_CONFIG: MemoryServiceConfig = {
  semanticRecallLimit: 5,
  semanticPromptHardCap: 12,
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
  getConversationHistoryPage: dbGetConversationHistoryPage,
  getConversationBranchFamilies: dbGetConversationBranchFamilies,
  getRecentMessages: dbGetRecentMessages,
  forkSessionBranch: dbForkSessionBranch,
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

// Keep citation previews short so tagged memories stay readable in prompts and
// channel footers without crowding out the main assistant response.
const CITATION_CONTENT_MAX_CHARS = 220;

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

    const vector = Array<number>(this.dimensions).fill(0);
    for (const token of tokens) {
      const hash = this.hashToken(token);
      const index = hash % this.dimensions;
      const sign = (hash & 1) === 0 ? 1 : -1;
      vector[index] = (vector[index] || 0) + sign * Math.min(4, token.length);
    }

    let norm = 0;
    for (let i = 0; i < vector.length; i += 1) {
      const value = vector[i] || 0;
      norm += value * value;
    }
    if (norm <= Number.EPSILON) return null;
    const scale = 1 / Math.sqrt(norm);
    for (let i = 0; i < vector.length; i += 1) {
      vector[i] = (vector[i] || 0) * scale;
    }
    return vector;
  }

  embedQuery(text: string): number[] | null {
    return this.embed(text);
  }

  embedDocument(text: string): number[] | null {
    return this.embed(text);
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
  private readonly defaultEmbeddingProvider: EmbeddingProvider;
  private readonly fixedEmbeddingProvider: EmbeddingProvider | null;
  private readonly consolidationEngine: MemoryConsolidationEngine;
  private readonly compactionLocks = new Map<
    string,
    Promise<CompactionResult>
  >();
  private runtimeEmbeddingProviderKey: string | null = null;
  private runtimeEmbeddingProvider: EmbeddingProvider | null = null;

  constructor(
    backend: MemoryBackend = DEFAULT_BACKEND,
    config?: Partial<MemoryServiceConfig>,
    embeddingProvider?: EmbeddingProvider,
  ) {
    this.backend = backend;
    this.config = { ...DEFAULT_CONFIG, ...(config || {}) };
    this.fixedEmbeddingProvider = embeddingProvider || null;
    this.defaultEmbeddingProvider = new HashedTokenEmbeddingProvider(
      this.config.embeddingDimensions,
    );
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

  getConversationHistoryPage(
    sessionId: string,
    limit = 50,
  ): ConversationHistoryPage {
    return this.backend.getConversationHistoryPage(sessionId, limit);
  }

  getConversationBranchFamilies(sessionId: string): ConversationBranchFamily[] {
    return this.backend.getConversationBranchFamilies(sessionId);
  }

  getRecentMessages(sessionId: string, limit?: number): StoredMessage[] {
    return this.backend.getRecentMessages(sessionId, limit);
  }

  forkSessionBranch(params: ForkSessionBranchParams): ForkSessionBranchResult {
    return this.backend.forkSessionBranch(params);
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

  consolidateMemories(): MemoryConsolidationReport {
    return this.consolidationEngine.consolidate();
  }

  async consolidateMemoriesWithCleanup(): Promise<MemoryConsolidationReport> {
    return this.consolidationEngine.consolidateWithCleanup();
  }

  setConsolidationDecayRate(decayRate: number): void {
    this.consolidationEngine.setDecayRate(decayRate);
  }

  setConsolidationLanguage(language: string): void {
    this.consolidationEngine.setLanguage(language);
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
        embed: (text) => this.embedDocument(text),
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
    const requestedLimit = Math.max(
      1,
      Math.floor(params.limit || this.config.semanticRecallLimit),
    );
    const limitHardCap =
      typeof params.limitHardCap === 'number' &&
      Number.isFinite(params.limitHardCap)
        ? Math.max(1, Math.floor(params.limitHardCap))
        : params.limitHardCap === null
          ? null
          : 50;
    const limit =
      limitHardCap == null
        ? requestedLimit
        : Math.min(requestedLimit, limitHardCap);
    const rawMinConfidence =
      typeof params.minConfidence === 'number' &&
      Number.isFinite(params.minConfidence)
        ? params.minConfidence
        : this.config.semanticMinConfidence;
    const minConfidence = Math.max(0, Math.min(1, rawMinConfidence));
    const queryMode = params.queryMode ?? this.resolveSemanticQueryMode();
    const backend = params.backend ?? this.resolveSemanticRecallBackend();
    const rerank = params.rerank ?? this.resolveSemanticRecallRerank();
    const tokenizer = params.tokenizer ?? this.resolveSemanticRecallTokenizer();
    const query = prepareMemoryRecallQuery(params.query, queryMode);

    return this.backend.recallSemanticMemories({
      sessionId: params.sessionId,
      query,
      limit,
      limitHardCap,
      minConfidence,
      queryEmbedding:
        backend === 'full-text'
          ? null
          : this.embedQuery(query, params.embeddingProvider),
      backend,
      rerank,
      tokenizer,
      filter: params.filter,
      touch: params.touch,
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

  storeSemanticMemory(params: {
    sessionId: string;
    role: string;
    source?: string | null;
    scope?: string | null;
    metadata?: Record<string, unknown> | string | null;
    content: string;
    confidence?: number;
    embedding?: number[] | null;
    embeddingProvider?: MemoryEmbeddingProviderKind;
    sourceMessageId?: number | null;
  }): number {
    const content = params.content.trim();
    if (!content) {
      throw new Error('Cannot store empty semantic memory content.');
    }

    return this.backend.storeSemanticMemory({
      ...params,
      content,
      embedding:
        params.embedding === undefined
          ? this.embedDocument(content, params.embeddingProvider)
          : params.embedding,
    });
  }

  storeTurn(params: StoreTurnParams): {
    userMessageId: number;
    assistantMessageId: number;
  } {
    const userMessageId = this.storeMessage({
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
    if (!interactionText) {
      return {
        userMessageId,
        assistantMessageId,
      };
    }

    this.storeSemanticMemory({
      sessionId: params.sessionId,
      role: 'assistant',
      source: 'conversation',
      scope: 'episodic',
      metadata: {},
      content: interactionText,
      confidence: 1,
      embeddingProvider: undefined,
      sourceMessageId: assistantMessageId,
    });

    return {
      userMessageId,
      assistantMessageId,
    };
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
        this.resolveSemanticPromptHardCap(),
      ),
    );
    const semanticMemories = this.recallSemanticMemories({
      sessionId: params.session.id,
      query: params.query,
      limit: semanticLimit,
      minConfidence: this.config.semanticMinConfidence,
      touch: params.touchSemanticRecall,
    });
    const citationIndex: MemoryCitation[] = semanticMemories.map(
      (memory, i) => ({
        ref: `[mem:${i + 1}]`,
        memoryId: memory.id,
        content: truncateInline(memory.content, CITATION_CONTENT_MAX_CHARS),
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
          'Topic-matched context from older turns.',
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

  private embedQuery(
    text: string,
    embeddingProvider?: MemoryEmbeddingProviderKind,
  ): number[] | null {
    return this.embedWithProvider('query', text, embeddingProvider);
  }

  warmupEmbeddingProvider(
    embeddingProvider?: MemoryEmbeddingProviderKind,
  ): void {
    const provider = this.resolveEmbeddingProvider(embeddingProvider);
    provider.warmup?.();
  }

  private embedDocument(
    text: string,
    embeddingProvider?: MemoryEmbeddingProviderKind,
  ): number[] | null {
    return this.embedWithProvider('document', text, embeddingProvider);
  }

  private embedWithProvider(
    kind: 'query' | 'document',
    text: string,
    embeddingProvider?: MemoryEmbeddingProviderKind,
  ): number[] | null {
    const provider = this.resolveEmbeddingProvider(embeddingProvider);
    if (kind === 'query' && typeof provider.embedQuery === 'function') {
      return provider.embedQuery(text);
    }
    if (kind === 'document' && typeof provider.embedDocument === 'function') {
      return provider.embedDocument(text);
    }
    if (typeof provider.embed === 'function') {
      return provider.embed(text);
    }
    throw new Error('Embedding provider does not implement any embed method.');
  }

  private resolveEmbeddingProvider(
    embeddingProvider?: MemoryEmbeddingProviderKind,
  ): EmbeddingProvider {
    if (this.fixedEmbeddingProvider) {
      return this.fixedEmbeddingProvider;
    }
    if (this.backend !== DEFAULT_BACKEND) {
      return this.defaultEmbeddingProvider;
    }

    const runtimeEmbedding = getRuntimeConfig().memory.embedding;
    const providerKind = normalizeMemoryEmbeddingProviderKind(
      embeddingProvider ?? runtimeEmbedding.provider,
      runtimeEmbedding.provider,
    );
    if (providerKind !== 'transformers') {
      this.runtimeEmbeddingProvider?.dispose?.();
      this.runtimeEmbeddingProvider = null;
      this.runtimeEmbeddingProviderKey = null;
      return this.defaultEmbeddingProvider;
    }

    const providerKey = JSON.stringify(runtimeEmbedding);
    if (
      this.runtimeEmbeddingProviderKey === providerKey &&
      this.runtimeEmbeddingProvider
    ) {
      return this.runtimeEmbeddingProvider;
    }

    this.runtimeEmbeddingProvider?.dispose?.();
    this.runtimeEmbeddingProvider = new TransformersJsEmbeddingProvider({
      model: runtimeEmbedding.model,
      revision: runtimeEmbedding.revision,
      dtype: runtimeEmbedding.dtype,
      cacheDir: getDefaultMemoryEmbeddingCacheDir(),
    });
    this.runtimeEmbeddingProviderKey = providerKey;
    return this.runtimeEmbeddingProvider;
  }

  private resolveSemanticPromptHardCap(): number {
    const configured = Math.max(
      1,
      Math.min(Math.floor(this.config.semanticPromptHardCap), 50),
    );
    if (this.backend !== DEFAULT_BACKEND) {
      return configured;
    }
    const runtimeValue = getRuntimeConfig().memory.semanticPromptHardCap;
    return Math.max(1, Math.min(Math.floor(runtimeValue), 50));
  }

  private resolveSemanticQueryMode(): MemoryQueryMode {
    if (this.backend !== DEFAULT_BACKEND) {
      return 'raw';
    }
    return getRuntimeConfig().memory.queryMode === 'no-stopwords'
      ? 'no-stopwords'
      : 'raw';
  }

  private resolveSemanticRecallBackend(): MemoryRecallBackend {
    if (this.backend !== DEFAULT_BACKEND) {
      return 'cosine';
    }
    return normalizeMemoryRecallBackend(
      getRuntimeConfig().memory.backend,
      'cosine',
    );
  }

  private resolveSemanticRecallRerank(): MemoryRecallRerank {
    if (this.backend !== DEFAULT_BACKEND) {
      return 'none';
    }
    return getRuntimeConfig().memory.rerank === 'bm25' ? 'bm25' : 'none';
  }

  private resolveSemanticRecallTokenizer(): MemoryRecallTokenizer {
    if (this.backend !== DEFAULT_BACKEND) {
      return 'unicode61';
    }
    return getRuntimeConfig().memory.tokenizer;
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
