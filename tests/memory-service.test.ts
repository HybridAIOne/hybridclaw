import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';

import {
  addKnowledgeEntity,
  addKnowledgeRelation,
  appendCanonicalMessages,
  decaySemanticMemories,
  deleteMemoryValue,
  forgetSemanticMemory,
  getCanonicalContext,
  getMemoryValue,
  getOrCreateSession,
  getUsageTotals,
  initDatabase,
  listMemoryValues,
  listUsageByAgent,
  listUsageByModel,
  listUsageDailyBreakdown,
  queryKnowledgeGraph,
  recallSemanticMemories,
  recordUsageEvent,
  setMemoryValue,
  storeSemanticMemory,
} from '../src/db.js';
import {
  computeDecayedConfidence,
  type MemoryBackend,
  MemoryService,
} from '../src/memory-service.js';
import {
  KnowledgeEntityType,
  KnowledgeRelationType,
  type SemanticMemoryEntry,
  type Session,
  type StoredMessage,
} from '../src/types.js';

function createTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-memory-'));
  return path.join(dir, 'test.db');
}

function makeSession(partial?: Partial<Session>): Session {
  return {
    id: 'session:test',
    guild_id: null,
    channel_id: 'channel:test',
    chatbot_id: null,
    model: null,
    enable_rag: 1,
    message_count: 0,
    session_summary: null,
    summary_updated_at: null,
    compaction_count: 0,
    memory_flush_at: null,
    created_at: new Date().toISOString(),
    last_active: new Date().toISOString(),
    ...(partial || {}),
  };
}

describe.sequential('semantic memory DB', () => {
  test('recalls topic-matched memories using LIKE-style matching', () => {
    const dbPath = createTempDbPath();
    initDatabase({ quiet: true, dbPath });
    getOrCreateSession('s-like', null, 'channel-a');

    storeSemanticMemory({
      sessionId: 's-like',
      role: 'user',
      content: 'User prefers Rust for backend services.',
      confidence: 0.95,
    });
    storeSemanticMemory({
      sessionId: 's-like',
      role: 'assistant',
      content: 'Discussed weekend gardening tasks.',
      confidence: 0.95,
    });
    storeSemanticMemory({
      sessionId: 's-like',
      role: 'assistant',
      content: 'Rust ownership and borrowing deep dive.',
      confidence: 0.6,
    });

    const results = recallSemanticMemories({
      sessionId: 's-like',
      query: 'rust backend',
      limit: 3,
      minConfidence: 0.2,
    });

    expect(results.length).toBe(2);
    expect(results[0].content.toLowerCase()).toContain('rust');
    expect(
      results.some((row) => row.content.toLowerCase().includes('gardening')),
    ).toBe(false);
  });

  test('ranks semantic memories by cosine similarity when query embedding is provided', () => {
    const dbPath = createTempDbPath();
    initDatabase({ quiet: true, dbPath });
    getOrCreateSession('s-vector', null, 'channel-c');

    storeSemanticMemory({
      sessionId: 's-vector',
      role: 'assistant',
      content: 'Rust systems programming notes',
      confidence: 0.9,
      embedding: [0.9, 0.1, 0, 0],
    });
    storeSemanticMemory({
      sessionId: 's-vector',
      role: 'assistant',
      content: 'Python scripting notes',
      confidence: 0.9,
      embedding: [0, 0, 0.9, 0.1],
    });

    const results = recallSemanticMemories({
      sessionId: 's-vector',
      query: '',
      queryEmbedding: [0.85, 0.15, 0, 0],
      limit: 2,
      minConfidence: 0.2,
    });

    expect(results.length).toBe(2);
    expect(results[0].content.toLowerCase()).toContain('rust');
    expect(results[1].content.toLowerCase()).toContain('python');
    expect(Array.isArray(results[0].embedding)).toBe(true);
    expect(results[0].embedding?.length).toBe(4);
  });

  test('uses vector recall path when query embedding is provided (no LIKE fallback)', () => {
    const dbPath = createTempDbPath();
    initDatabase({ quiet: true, dbPath });
    getOrCreateSession('s-fallback', null, 'channel-d');

    storeSemanticMemory({
      sessionId: 's-fallback',
      role: 'assistant',
      content: 'Gardening checklist for spring planting.',
      confidence: 0.9,
    });

    const results = recallSemanticMemories({
      sessionId: 's-fallback',
      query: 'changelog concise',
      queryEmbedding: [0.4, 0.2, 0.1, 0.7],
      limit: 3,
      minConfidence: 0.2,
    });

    expect(results.length).toBe(1);
    expect(results[0].content.toLowerCase()).toContain('gardening');
    expect(results[0].embedding).toBeNull();
  });

  test('decays stale memories and keeps fresh ones unchanged', () => {
    const dbPath = createTempDbPath();
    initDatabase({ quiet: true, dbPath });
    getOrCreateSession('s-decay', null, 'channel-b');

    const oldDate = new Date(Date.now() - 30 * 86_400_000).toISOString();
    storeSemanticMemory({
      sessionId: 's-decay',
      role: 'assistant',
      content: 'Project alpha decision log.',
      confidence: 0.8,
      createdAt: oldDate,
      accessedAt: oldDate,
    });
    storeSemanticMemory({
      sessionId: 's-decay',
      role: 'assistant',
      content: 'Project beta status update.',
      confidence: 0.8,
    });

    const changed = decaySemanticMemories({
      decayRate: 0.5,
      staleAfterDays: 7,
      minConfidence: 0.1,
    });
    expect(changed).toBe(1);

    const results = recallSemanticMemories({
      sessionId: 's-decay',
      query: 'project',
      limit: 5,
      minConfidence: 0.1,
    });
    const alpha = results.find((row) =>
      row.content.toLowerCase().includes('alpha'),
    );
    const beta = results.find((row) =>
      row.content.toLowerCase().includes('beta'),
    );
    expect(alpha?.confidence).toBeCloseTo(0.4, 5);
    expect(beta?.confidence).toBeCloseTo(0.8, 5);
  });

  test('default decay matches OpenFang-style confidence*=0.9 with 0.1 floor', () => {
    const dbPath = createTempDbPath();
    initDatabase({ quiet: true, dbPath });
    getOrCreateSession('s-default-decay', null, 'channel-e');

    const oldDate = new Date(Date.now() - 20 * 86_400_000).toISOString();
    storeSemanticMemory({
      sessionId: 's-default-decay',
      role: 'assistant',
      content: 'Old default-decay memory.',
      confidence: 0.9,
      createdAt: oldDate,
      accessedAt: oldDate,
    });
    storeSemanticMemory({
      sessionId: 's-default-decay',
      role: 'assistant',
      content: 'Already near floor.',
      confidence: 0.1,
      createdAt: oldDate,
      accessedAt: oldDate,
    });

    const changed = decaySemanticMemories();
    expect(changed).toBe(1);

    const results = recallSemanticMemories({
      sessionId: 's-default-decay',
      query: 'default-decay floor',
      limit: 5,
      minConfidence: 0.1,
    });
    const old = results.find((row) =>
      row.content.toLowerCase().includes('default-decay'),
    );
    const floor = results.find((row) =>
      row.content.toLowerCase().includes('near floor'),
    );
    expect(old?.confidence).toBeCloseTo(0.81, 5);
    expect(floor?.confidence).toBeCloseTo(0.1, 5);
  });
});

describe.sequential('structured memory DB', () => {
  test('stores, reads, lists, and deletes key-value memory', () => {
    const dbPath = createTempDbPath();
    initDatabase({ quiet: true, dbPath });
    getOrCreateSession('s-kv', null, 'channel-kv');

    expect(getMemoryValue('s-kv', 'release.codename')).toBeNull();

    setMemoryValue('s-kv', 'release.codename', 'AtlasFox');
    setMemoryValue('s-kv', 'release.tag', { format: 'rYY.MM.patch' });
    setMemoryValue('s-kv', 'release.channel', ['stable', 'beta']);

    expect(getMemoryValue('s-kv', 'release.codename')).toBe('AtlasFox');
    expect(getMemoryValue('s-kv', 'release.tag')).toEqual({
      format: 'rYY.MM.patch',
    });
    expect(getMemoryValue('s-kv', 'release.channel')).toEqual([
      'stable',
      'beta',
    ]);

    const prefixed = listMemoryValues('s-kv', 'release.');
    expect(prefixed.length).toBe(3);
    expect(prefixed.every((entry) => entry.key.startsWith('release.'))).toBe(
      true,
    );
    expect(prefixed.every((entry) => entry.agent_id === 's-kv')).toBe(true);
    expect(prefixed.every((entry) => entry.version === 1)).toBe(true);

    setMemoryValue('s-kv', 'release.tag', {
      format: 'rYY.MM.patch',
      major: 26,
    });
    const updated = listMemoryValues('s-kv', 'release.').find(
      (entry) => entry.key === 'release.tag',
    );
    expect(updated?.version).toBe(2);
    expect(updated?.value).toEqual({ format: 'rYY.MM.patch', major: 26 });

    expect(deleteMemoryValue('s-kv', 'release.codename')).toBe(true);
    expect(deleteMemoryValue('s-kv', 'release.codename')).toBe(false);
    expect(getMemoryValue('s-kv', 'release.codename')).toBeNull();
  });
});

describe.sequential('schema migrations', () => {
  test('initializes WAL mode and stamps user_version schema', () => {
    const dbPath = createTempDbPath();
    initDatabase({ quiet: true, dbPath });

    const inspect = new Database(dbPath, { readonly: true });
    const journalMode = inspect.pragma('journal_mode', { simple: true });
    const schemaVersion = inspect.pragma('user_version', { simple: true });
    inspect.close();

    expect(String(journalMode).toLowerCase()).toBe('wal');
    expect(Number(schemaVersion)).toBe(4);
  });

  test('migrates legacy memory_kv rows and creates knowledge graph tables', () => {
    const dbPath = createTempDbPath();
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        guild_id TEXT,
        channel_id TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        last_active TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        cron_expr TEXT NOT NULL,
        prompt TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        last_run TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE semantic_memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        source_message_id INTEGER,
        created_at TEXT DEFAULT (datetime('now')),
        accessed_at TEXT DEFAULT (datetime('now')),
        access_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE memory_kv (
        session_id TEXT NOT NULL,
        mem_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at TEXT,
        PRIMARY KEY (session_id, mem_key)
      );
    `);
    legacy
      .prepare(
        `INSERT INTO memory_kv (session_id, mem_key, value_json, updated_at)
         VALUES (?, ?, ?, datetime('now'))`,
      )
      .run('legacy-session', 'release.codename', '"AtlasFox"');
    legacy.close();

    initDatabase({ quiet: true, dbPath });

    expect(getMemoryValue('legacy-session', 'release.codename')).toBe(
      'AtlasFox',
    );

    const inspect = new Database(dbPath, { readonly: true });
    const schemaVersion = inspect.pragma('user_version', { simple: true });
    const hasEntities = inspect
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'entities'",
      )
      .get() as { name: string } | undefined;
    const hasRelations = inspect
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'relations'",
      )
      .get() as { name: string } | undefined;
    const hasCanonical = inspect
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'canonical_sessions'",
      )
      .get() as { name: string } | undefined;
    const hasUsage = inspect
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage_events'",
      )
      .get() as { name: string } | undefined;
    inspect.close();

    expect(Number(schemaVersion)).toBe(4);
    expect(hasEntities?.name).toBe('entities');
    expect(hasRelations?.name).toBe('relations');
    expect(hasCanonical?.name).toBe('canonical_sessions');
    expect(hasUsage?.name).toBe('usage_events');
  });
});

describe.sequential('knowledge graph DB', () => {
  test('adds entities + relations and queries graph patterns', () => {
    const dbPath = createTempDbPath();
    initDatabase({ quiet: true, dbPath });

    const aliceId = addKnowledgeEntity({
      id: 'alice',
      name: 'Alice',
      entityType: KnowledgeEntityType.Person,
    });
    const acmeId = addKnowledgeEntity({
      id: 'acme',
      name: 'Acme Corp',
      entityType: KnowledgeEntityType.Organization,
    });

    const relationId = addKnowledgeRelation({
      source: aliceId,
      relation: KnowledgeRelationType.WorksAt,
      target: acmeId,
      confidence: 0.95,
    });
    expect(relationId.length).toBeGreaterThan(0);

    const matches = queryKnowledgeGraph({
      source: 'alice',
      relation: KnowledgeRelationType.WorksAt,
      max_depth: 3,
    });
    expect(matches.length).toBe(1);
    expect(matches[0]?.source.name).toBe('Alice');
    expect(matches[0]?.source.entity_type).toBe(KnowledgeEntityType.Person);
    expect(matches[0]?.target.name).toBe('Acme Corp');
    expect(matches[0]?.relation.relation).toBe(KnowledgeRelationType.WorksAt);
    expect(matches[0]?.relation.confidence).toBeCloseTo(0.95, 5);
  });

  test('round-trips custom entity/relation types in OpenFang JSON enum shape', () => {
    const dbPath = createTempDbPath();
    initDatabase({ quiet: true, dbPath });

    const systemId = addKnowledgeEntity({
      id: 'payments',
      name: 'Payments Gateway',
      entityType: 'service',
      properties: { owner: 'platform' },
    });
    const providerId = addKnowledgeEntity({
      id: 'stripe',
      name: 'Stripe',
      entityType: 'vendor',
    });
    addKnowledgeRelation({
      source: systemId,
      relation: 'integrates_with',
      target: providerId,
      properties: { direction: 'outbound' },
      confidence: 0.7,
    });

    const matches = queryKnowledgeGraph({
      source: 'payments',
      relation: { custom: 'integrates_with' },
    });
    expect(matches.length).toBe(1);
    expect(matches[0]?.source.entity_type).toEqual({ custom: 'service' });
    expect(matches[0]?.target.entity_type).toEqual({ custom: 'vendor' });
    expect(matches[0]?.relation.relation).toEqual({
      custom: 'integrates_with',
    });
    expect(matches[0]?.relation.properties).toEqual({ direction: 'outbound' });
  });
});

describe.sequential('canonical sessions DB', () => {
  test('appends cross-channel messages and returns context excluding current session', () => {
    const dbPath = createTempDbPath();
    initDatabase({ quiet: true, dbPath });

    appendCanonicalMessages({
      agentId: 'agent-main',
      userId: 'user-42',
      newMessages: [
        {
          role: 'user',
          content: 'hello from telegram',
          sessionId: 'tg:1',
          channelId: 'telegram',
        },
        {
          role: 'assistant',
          content: 'hi, I am here',
          sessionId: 'tg:1',
          channelId: 'telegram',
        },
      ],
    });
    appendCanonicalMessages({
      agentId: 'agent-main',
      userId: 'user-42',
      newMessages: [
        {
          role: 'user',
          content: 'now from discord',
          sessionId: 'dc:9',
          channelId: 'discord',
        },
      ],
    });

    const context = getCanonicalContext({
      agentId: 'agent-main',
      userId: 'user-42',
      excludeSessionId: 'dc:9',
    });
    expect(context.summary).toBeNull();
    expect(context.recent_messages.length).toBe(2);
    expect(
      context.recent_messages.every((row) => row.session_id === 'tg:1'),
    ).toBe(true);
  });

  test('compacts canonical history into summary after threshold', () => {
    const dbPath = createTempDbPath();
    initDatabase({ quiet: true, dbPath });

    const rows = Array.from({ length: 140 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${i} with enough detail for canonical compaction`,
      sessionId: i < 70 ? 'dc:older' : 'dc:newer',
      channelId: 'discord',
    }));
    appendCanonicalMessages({
      agentId: 'agent-main',
      userId: 'user-77',
      newMessages: rows,
      compactionThreshold: 100,
      windowSize: 50,
    });

    const context = getCanonicalContext({
      agentId: 'agent-main',
      userId: 'user-77',
    });
    expect(context.summary).toBeTruthy();
    expect(context.recent_messages.length).toBeLessThanOrEqual(50);
  });
});

describe.sequential('usage aggregation DB', () => {
  test('records usage events and returns daily/monthly + by-model aggregates', () => {
    const dbPath = createTempDbPath();
    initDatabase({ quiet: true, dbPath });

    recordUsageEvent({
      sessionId: 's-a',
      agentId: 'agent-a',
      model: 'gpt-5-nano',
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      toolCalls: 2,
      costUsd: 0.0009,
    });
    recordUsageEvent({
      sessionId: 's-b',
      agentId: 'agent-a',
      model: 'gpt-5-mini',
      inputTokens: 500,
      outputTokens: 150,
      totalTokens: 650,
      toolCalls: 1,
      costUsd: 0.004,
    });
    recordUsageEvent({
      sessionId: 's-c',
      agentId: 'agent-b',
      model: 'gpt-5-nano',
      inputTokens: 200,
      outputTokens: 80,
      totalTokens: 280,
      toolCalls: 0,
      costUsd: 0.0013,
    });

    const agentDaily = getUsageTotals({
      agentId: 'agent-a',
      window: 'daily',
    });
    expect(agentDaily.call_count).toBe(2);
    expect(agentDaily.total_tokens).toBe(800);
    expect(agentDaily.total_cost_usd).toBeCloseTo(0.0049, 6);

    const monthlyByModel = listUsageByModel({
      window: 'monthly',
    });
    expect(monthlyByModel.length).toBe(2);
    expect(monthlyByModel[0]?.model).toBe('gpt-5-mini');
    expect(monthlyByModel[0]?.total_cost_usd).toBeCloseTo(0.004, 6);

    const dailyByAgent = listUsageByAgent({
      window: 'daily',
    });
    expect(dailyByAgent.length).toBe(2);
    expect(dailyByAgent[0]?.agent_id).toBe('agent-a');
    expect(dailyByAgent[0]?.total_tokens).toBe(800);

    const dailyBreakdown = listUsageDailyBreakdown({ days: 7 });
    expect(dailyBreakdown.length).toBe(1);
    expect(dailyBreakdown[0]?.call_count).toBe(3);
    expect(dailyBreakdown[0]?.total_tokens).toBe(1_080);
  });
});

describe('MemoryService', () => {
  test('computeDecayedConfidence drops as summary age increases', () => {
    const updatedAt = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const confidence = computeDecayedConfidence({
      updatedAt,
      decayRate: 0.05,
      minConfidence: 0.1,
      nowMs: Date.now(),
    });
    expect(confidence).toBeLessThan(0.25);
    expect(confidence).toBeGreaterThanOrEqual(0.1);
  });

  test('buildPromptMemoryContext drops stale summary below threshold and does fresh recall calls', () => {
    let recallCalls = 0;
    const recalled: SemanticMemoryEntry[] = [
      {
        id: 1,
        session_id: 'session:test',
        role: 'assistant',
        source: 'conversation',
        scope: 'episodic',
        metadata: {},
        content: 'User likes concise changelog entries.',
        confidence: 0.9,
        embedding: null,
        source_message_id: null,
        created_at: new Date().toISOString(),
        accessed_at: new Date().toISOString(),
        access_count: 0,
      },
    ];
    const backend: MemoryBackend = {
      getOrCreateSession: (sessionId, guildId, channelId) =>
        makeSession({
          id: sessionId,
          guild_id: guildId,
          channel_id: channelId,
        }),
      getSessionById: () => makeSession(),
      getConversationHistory: () => [] as StoredMessage[],
      getRecentMessages: () => [] as StoredMessage[],
      get: () => null,
      set: () => {},
      delete: () => false,
      list: () => [],
      appendCanonicalMessages: () => ({
        canonical_id: 'entity-id:u1',
        agent_id: 'entity-id',
        user_id: 'u1',
        messages: [],
        compaction_cursor: 0,
        compacted_summary: null,
        message_count: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
      getCanonicalContext: () => ({ summary: null, recent_messages: [] }),
      addKnowledgeEntity: () => 'entity-id',
      addKnowledgeRelation: () => 'relation-id',
      queryKnowledgeGraph: () => [],
      getCompactionCandidateMessages: () => null,
      storeMessage: () => 42,
      storeSemanticMemory: () => 10,
      recallSemanticMemories: () => {
        recallCalls += 1;
        return recalled.map((row) => ({ ...row }));
      },
      forgetSemanticMemory: () => false,
      decaySemanticMemories: () => 0,
      clearSessionHistory: () => 0,
      deleteMessagesBeforeId: () => 0,
      updateSessionSummary: () => {},
      markSessionMemoryFlush: () => {},
    };

    const service = new MemoryService(backend, {
      summaryDecayRate: 0.2,
      summaryDiscardThreshold: 0.3,
    });
    const staleSession = makeSession({
      session_summary: 'Old summary that should be filtered out.',
      summary_updated_at: new Date(Date.now() - 40 * 86_400_000).toISOString(),
    });

    const first = service.buildPromptMemoryContext({
      session: staleSession,
      query: 'changelog',
    });
    const second = service.buildPromptMemoryContext({
      session: staleSession,
      query: 'changelog',
    });

    expect(first.summaryConfidence).toBeLessThan(0.3);
    expect(first.promptSummary).toContain('Relevant Memory Recall');
    expect(first.promptSummary).not.toContain(
      'Old summary that should be filtered out.',
    );
    expect(second.promptSummary).toContain('Relevant Memory Recall');
    expect(recallCalls).toBe(2);
  });

  test('storeTurn writes one interaction semantic memory in OpenFang format', () => {
    const storedSemantic: Array<{
      role: string;
      source?: string | null;
      scope?: string | null;
      content: string;
      sourceMessageId?: number | null;
    }> = [];
    const storedMessages: Array<{ role: string; content: string }> = [];
    let nextMessageId = 100;
    const backend: MemoryBackend = {
      getOrCreateSession: (sessionId, guildId, channelId) =>
        makeSession({
          id: sessionId,
          guild_id: guildId,
          channel_id: channelId,
        }),
      getSessionById: () => makeSession(),
      getConversationHistory: () => [] as StoredMessage[],
      getRecentMessages: () => [] as StoredMessage[],
      get: () => null,
      set: () => {},
      delete: () => false,
      list: () => [],
      appendCanonicalMessages: () => ({
        canonical_id: 'entity-id:u1',
        agent_id: 'entity-id',
        user_id: 'u1',
        messages: [],
        compaction_cursor: 0,
        compacted_summary: null,
        message_count: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
      getCanonicalContext: () => ({ summary: null, recent_messages: [] }),
      addKnowledgeEntity: () => 'entity-id',
      addKnowledgeRelation: () => 'relation-id',
      queryKnowledgeGraph: () => [],
      getCompactionCandidateMessages: () => null,
      storeMessage: (_sessionId, _userId, _username, role, content) => {
        storedMessages.push({ role, content });
        nextMessageId += 1;
        return nextMessageId;
      },
      storeSemanticMemory: ({
        role,
        source,
        scope,
        content,
        sourceMessageId,
      }) => {
        storedSemantic.push({ role, source, scope, content, sourceMessageId });
        return 1;
      },
      recallSemanticMemories: () => [] as SemanticMemoryEntry[],
      forgetSemanticMemory: () => false,
      decaySemanticMemories: () => 0,
      clearSessionHistory: () => 0,
      deleteMessagesBeforeId: () => 0,
      updateSessionSummary: () => {},
      markSessionMemoryFlush: () => {},
    };
    const service = new MemoryService(backend);

    service.storeTurn({
      sessionId: 'session:test',
      user: {
        userId: 'u1',
        username: 'user',
        content: 'What was the release codename?',
      },
      assistant: {
        userId: 'assistant',
        username: null,
        content: 'The release codename is AtlasFox.',
      },
    });

    expect(storedMessages.length).toBe(2);
    expect(storedMessages[0]).toEqual({
      role: 'user',
      content: 'What was the release codename?',
    });
    expect(storedMessages[1]).toEqual({
      role: 'assistant',
      content: 'The release codename is AtlasFox.',
    });
    expect(storedSemantic.length).toBe(1);
    expect(storedSemantic[0]?.role).toBe('assistant');
    expect(storedSemantic[0]?.source).toBe('conversation');
    expect(storedSemantic[0]?.scope).toBe('episodic');
    expect(storedSemantic[0]?.content).toBe(
      'User asked: What was the release codename? I responded: The release codename is AtlasFox.',
    );
    expect(storedSemantic[0]?.sourceMessageId).toBe(102);
  });

  test('storeMessage does not write semantic memory entries', () => {
    let semanticWrites = 0;
    const backend: MemoryBackend = {
      getOrCreateSession: (sessionId, guildId, channelId) =>
        makeSession({
          id: sessionId,
          guild_id: guildId,
          channel_id: channelId,
        }),
      getSessionById: () => makeSession(),
      getConversationHistory: () => [] as StoredMessage[],
      getRecentMessages: () => [] as StoredMessage[],
      get: () => null,
      set: () => {},
      delete: () => false,
      list: () => [],
      appendCanonicalMessages: () => ({
        canonical_id: 'entity-id:u1',
        agent_id: 'entity-id',
        user_id: 'u1',
        messages: [],
        compaction_cursor: 0,
        compacted_summary: null,
        message_count: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
      getCanonicalContext: () => ({ summary: null, recent_messages: [] }),
      addKnowledgeEntity: () => 'entity-id',
      addKnowledgeRelation: () => 'relation-id',
      queryKnowledgeGraph: () => [],
      getCompactionCandidateMessages: () => null,
      storeMessage: () => 42,
      storeSemanticMemory: () => {
        semanticWrites += 1;
        return 10;
      },
      recallSemanticMemories: () => [] as SemanticMemoryEntry[],
      forgetSemanticMemory: () => false,
      decaySemanticMemories: () => 0,
      clearSessionHistory: () => 0,
      deleteMessagesBeforeId: () => 0,
      updateSessionSummary: () => {},
      markSessionMemoryFlush: () => {},
    };

    const service = new MemoryService(backend);
    service.storeMessage({
      sessionId: 'session:test',
      userId: 'u1',
      username: 'user',
      role: 'user',
      content: 'Remember this codename please.',
    });

    expect(semanticWrites).toBe(0);
  });

  test('semantic recall increments access_count on repeated identical queries', () => {
    const dbPath = createTempDbPath();
    initDatabase({ quiet: true, dbPath });
    getOrCreateSession('s-access', null, 'channel-h');

    storeSemanticMemory({
      sessionId: 's-access',
      role: 'assistant',
      content: 'Release codename is AtlasFox.',
      confidence: 1,
    });

    const service = new MemoryService();
    const first = service.recallSemanticMemories({
      sessionId: 's-access',
      query: 'release codename atlasfox',
      limit: 1,
      minConfidence: 0.1,
    });
    const second = service.recallSemanticMemories({
      sessionId: 's-access',
      query: 'release codename atlasfox',
      limit: 1,
      minConfidence: 0.1,
    });

    expect(first[0]?.access_count).toBe(0);
    expect(second[0]?.access_count).toBe(1);
  });

  test('forgets semantic memory and excludes it from recall', () => {
    const dbPath = createTempDbPath();
    initDatabase({ quiet: true, dbPath });
    getOrCreateSession('s-forget', null, 'channel-f');

    const keepId = storeSemanticMemory({
      sessionId: 's-forget',
      role: 'user',
      content: 'Keep this memory available.',
      confidence: 1,
    });
    const deleteId = storeSemanticMemory({
      sessionId: 's-forget',
      role: 'user',
      content: 'Delete this memory now.',
      confidence: 1,
    });

    expect(forgetSemanticMemory(deleteId)).toBe(true);
    expect(forgetSemanticMemory(deleteId)).toBe(false);

    const results = recallSemanticMemories({
      sessionId: 's-forget',
      query: 'memory',
      minConfidence: 0.1,
      limit: 10,
    });
    const ids = new Set(results.map((row) => row.id));
    expect(ids.has(keepId)).toBe(true);
    expect(ids.has(deleteId)).toBe(false);
  });

  test('recalls with source/scope filters', () => {
    const dbPath = createTempDbPath();
    initDatabase({ quiet: true, dbPath });
    getOrCreateSession('s-filter', null, 'channel-g');

    storeSemanticMemory({
      sessionId: 's-filter',
      role: 'user',
      source: 'conversation',
      scope: 'episodic',
      content: 'AtlasFox codename context.',
      confidence: 0.9,
    });
    storeSemanticMemory({
      sessionId: 's-filter',
      role: 'user',
      source: 'tool',
      scope: 'project',
      content: 'AtlasFox release metadata.',
      confidence: 0.9,
    });

    const episodic = recallSemanticMemories({
      sessionId: 's-filter',
      query: 'AtlasFox',
      minConfidence: 0.1,
      filter: { source: 'conversation', scope: 'episodic' },
      limit: 10,
    });
    const project = recallSemanticMemories({
      sessionId: 's-filter',
      query: 'AtlasFox',
      minConfidence: 0.1,
      filter: { source: 'tool', scope: 'project' },
      limit: 10,
    });

    expect(episodic.length).toBe(1);
    expect(episodic[0]?.source).toBe('conversation');
    expect(episodic[0]?.scope).toBe('episodic');
    expect(project.length).toBe(1);
    expect(project[0]?.source).toBe('tool');
    expect(project[0]?.scope).toBe('project');
  });

  test('proxies structured, canonical, and knowledge graph methods through MemoryService', () => {
    const graphResults = [
      {
        source: {
          id: 'alice',
          entity_type: KnowledgeEntityType.Person,
          name: 'Alice',
          properties: {},
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        relation: {
          source: 'alice',
          relation: KnowledgeRelationType.WorksAt,
          target: 'acme',
          properties: {},
          confidence: 0.95,
          created_at: new Date().toISOString(),
        },
        target: {
          id: 'acme',
          entity_type: KnowledgeEntityType.Organization,
          name: 'Acme Corp',
          properties: {},
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      },
    ];
    const canonicalContext = {
      summary: 'User discussed release schedule on another channel.',
      recent_messages: [
        {
          role: 'assistant',
          content: 'Release is planned for Friday.',
          session_id: 'other:session',
          channel_id: 'discord',
          created_at: new Date().toISOString(),
        },
      ],
    };
    const backend: MemoryBackend = {
      getOrCreateSession: (sessionId, guildId, channelId) =>
        makeSession({
          id: sessionId,
          guild_id: guildId,
          channel_id: channelId,
        }),
      getSessionById: () => makeSession(),
      getConversationHistory: () => [] as StoredMessage[],
      getRecentMessages: () => [] as StoredMessage[],
      get: (_sessionId, key) =>
        key === 'release.codename' ? 'AtlasFox' : null,
      set: () => {},
      delete: (_sessionId, key) => key === 'release.codename',
      list: () => [
        {
          agent_id: 'session:test',
          key: 'release.codename',
          value: 'AtlasFox',
          version: 3,
          updated_at: new Date().toISOString(),
        },
      ],
      appendCanonicalMessages: () => ({
        canonical_id: 'entity-id:u1',
        agent_id: 'entity-id',
        user_id: 'u1',
        messages: [],
        compaction_cursor: 0,
        compacted_summary: null,
        message_count: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
      getCanonicalContext: () => canonicalContext,
      addKnowledgeEntity: () => 'entity-id',
      addKnowledgeRelation: () => 'relation-id',
      queryKnowledgeGraph: () => graphResults,
      getCompactionCandidateMessages: () => null,
      storeMessage: () => 42,
      storeSemanticMemory: () => 10,
      recallSemanticMemories: () => [] as SemanticMemoryEntry[],
      forgetSemanticMemory: () => false,
      decaySemanticMemories: () => 0,
      clearSessionHistory: () => 0,
      deleteMessagesBeforeId: () => 0,
      updateSessionSummary: () => {},
      markSessionMemoryFlush: () => {},
    };
    const service = new MemoryService(backend);

    expect(service.get('session:test', 'release.codename')).toBe('AtlasFox');
    service.set('session:test', 'release.codename', 'AtlasFox');
    expect(service.delete('session:test', 'release.codename')).toBe(true);
    expect(service.list('session:test', 'release.').length).toBe(1);
    expect(
      service.appendCanonicalMessages({
        agentId: 'entity-id',
        userId: 'u1',
        newMessages: [
          {
            role: 'user',
            content: 'Remember this across channels.',
            sessionId: 'session:test',
          },
        ],
      }).canonical_id,
    ).toBe('entity-id:u1');
    expect(
      service.getCanonicalContext({
        agentId: 'entity-id',
        userId: 'u1',
      }),
    ).toEqual(canonicalContext);
    expect(
      service.addKnowledgeEntity({
        name: 'Alice',
        entityType: KnowledgeEntityType.Person,
      }),
    ).toBe('entity-id');
    expect(
      service.addKnowledgeRelation({
        source: 'alice',
        relation: KnowledgeRelationType.WorksAt,
        target: 'acme',
      }),
    ).toBe('relation-id');
    expect(
      service.queryKnowledgeGraph({
        source: 'alice',
      }),
    ).toEqual(graphResults);
  });
});
