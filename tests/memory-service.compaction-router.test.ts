import { afterEach, expect, test, vi } from 'vitest';

import type { MemoryBackend } from '../src/memory/memory-service.js';
import type { Session, StoredMessage } from '../src/types.js';

function makeSession(partial?: Partial<Session>): Session {
  return {
    id: 'session:test',
    guild_id: null,
    channel_id: 'channel:test',
    agent_id: 'main',
    chatbot_id: 'bot-1',
    model: 'gpt-5-nano',
    enable_rag: 1,
    message_count: 0,
    session_summary: null,
    summary_updated_at: null,
    compaction_count: 0,
    memory_flush_at: null,
    full_auto_enabled: 0,
    full_auto_prompt: null,
    full_auto_started_at: null,
    show_mode: 'all',
    created_at: new Date().toISOString(),
    last_active: new Date().toISOString(),
    ...(partial || {}),
  };
}

function makeBackend(): MemoryBackend {
  return {
    resetSessionIfExpired: () => false,
    getOrCreateSession: () => makeSession(),
    getSessionById: () => makeSession(),
    getConversationHistory: () => [] as StoredMessage[],
    getConversationHistoryPage: () => ({
      sessionKey: null,
      mainSessionKey: null,
      history: [] as StoredMessage[],
    }),
    getRecentMessages: () => [] as StoredMessage[],
    get: () => null,
    set: () => {},
    delete: () => false,
    list: () => [],
    appendCanonicalMessages: () => ({
      canonical_id: 'canon-1',
      agent_id: 'main',
      user_id: 'user',
      messages: [],
      compaction_cursor: 0,
      compacted_summary: null,
      message_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
    getCanonicalContext: () => ({ summary: null, recent_messages: [] }),
    addKnowledgeEntity: () => 'entity-1',
    addKnowledgeRelation: () => 'relation-1',
    queryKnowledgeGraph: () => [],
    getCompactionCandidateMessages: () => null,
    storeMessage: () => 1,
    storeSemanticMemory: () => 1,
    recallSemanticMemories: () => [],
    forgetSemanticMemory: () => false,
    decaySemanticMemories: () => 0,
    clearSessionHistory: () => 0,
    deleteMessagesBeforeId: () => 0,
    deleteMessagesByIds: () => 0,
    updateSessionSummary: () => {},
    markSessionMemoryFlush: () => {},
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('../src/providers/auxiliary.js');
});

test('MemoryService routes compaction prompts through the compression auxiliary caller', async () => {
  const callAuxiliaryModel = vi.fn(async () => ({
    provider: 'lmstudio',
    model: 'lmstudio/qwen/qwen2.5-instruct',
    content: '## Goals\n- Keep durable context.\n',
  }));
  vi.doMock('../src/providers/auxiliary.js', async () => {
    const actual = await vi.importActual<
      typeof import('../src/providers/auxiliary.js')
    >('../src/providers/auxiliary.js');
    return {
      ...actual,
      callAuxiliaryModel,
    };
  });

  const { MemoryService } = await import('../src/memory/memory-service.js');
  const service = new MemoryService(makeBackend(), undefined, {
    embed: () => null,
  });

  const summary = await (
    service as MemoryService & {
      runCompactionPrompt: (params: {
        session: Session;
        systemPrompt: string;
        userPrompt: string;
        stageKind: 'single' | 'part' | 'merge';
        stageIndex: number;
        stageTotal: number;
      }) => Promise<string>;
    }
  ).runCompactionPrompt({
    session: makeSession(),
    systemPrompt: 'Compress this session.',
    userPrompt: 'Here is the transcript.',
    stageKind: 'single',
    stageIndex: 0,
    stageTotal: 1,
  });

  expect(summary).toContain('## Goals');
  expect(callAuxiliaryModel).toHaveBeenCalledWith({
    task: 'compression',
    agentId: 'main',
    fallbackModel: 'gpt-5-nano',
    fallbackChatbotId: 'bot-1',
    fallbackEnableRag: true,
    messages: [
      { role: 'system', content: 'Compress this session.' },
      { role: 'user', content: 'Here is the transcript.' },
    ],
  });
});
