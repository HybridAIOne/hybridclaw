import { afterEach, describe, expect, test, vi } from 'vitest';

import type { AgentConfig } from '../src/agents/agent-types.ts';
import type { GatewaySessionCard } from '../src/gateway/gateway-types.ts';
import type { StoredMessage } from '../src/types/session.ts';

const resolveAgentConfigMock = vi.fn();
const resolveAgentForRequestMock = vi.fn(() => ({
  agentId: 'main',
  model: 'gpt-5',
}));
const resolveAgentModelMock = vi.fn();
const agentWorkspaceDirMock = vi.fn(
  (agentId: string) => `/tmp/agents/${agentId}/workspace`,
);
const getRecentMessagesMock = vi.fn(() => [] as StoredMessage[]);
const loggerDebugMock = vi.fn();

vi.mock('../src/agents/agent-registry.js', () => ({
  resolveAgentConfig: resolveAgentConfigMock,
  resolveAgentForRequest: resolveAgentForRequestMock,
  resolveAgentModel: resolveAgentModelMock,
}));

vi.mock('../src/channels/discord/runtime.js', () => ({
  getDiscordChannelDisplayName: vi.fn(),
}));

vi.mock('../src/infra/ipc.js', () => ({
  agentWorkspaceDir: agentWorkspaceDirMock,
}));

vi.mock('../src/memory/db.js', () => ({
  getRecentMessages: getRecentMessagesMock,
  getRecentStructuredAuditForSession: vi.fn(() => []),
  resetSessionIfExpired: vi.fn(() => null),
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    debug: loggerDebugMock,
  },
}));

vi.mock('../src/gateway/fullauto.js', () => ({
  isFullAutoEnabled: vi.fn(() => false),
}));

afterEach(() => {
  vi.clearAllMocks();
});

function makeSessionCard(
  overrides: Partial<GatewaySessionCard>,
): GatewaySessionCard {
  return {
    id: 'sess-1',
    name: 'Session',
    task: 'Task',
    lastQuestion: null,
    lastAnswer: null,
    fullAutoEnabled: false,
    model: 'gpt-5',
    sessionId: 'sess-1',
    channelId: 'local',
    channelName: null,
    agentId: 'main',
    startedAt: '2026-03-12T10:00:00.000Z',
    lastActive: '2026-03-12T10:00:00.000Z',
    runtimeMinutes: 5,
    inputTokens: 10,
    outputTokens: 2,
    costUsd: 0.1,
    messageCount: 3,
    toolCalls: 1,
    status: 'active',
    watcher: 'host runtime attached',
    previewTitle: 'Recent activity',
    previewMeta: '1 item',
    output: ['done'],
    ...overrides,
  };
}

describe('mapLogicalAgentCard', () => {
  test('aggregates sessions into a logical agent summary', async () => {
    const agent: AgentConfig = {
      id: 'main',
      name: 'Main Agent',
      model: 'gpt-5',
      enableRag: true,
    };
    resolveAgentConfigMock.mockReturnValue(agent);
    resolveAgentModelMock.mockReturnValue('gpt-5');

    const { mapLogicalAgentCard } = await import(
      '../src/gateway/gateway-agent-cards.ts'
    );

    const card = mapLogicalAgentCard({
      agent,
      sessions: [
        makeSessionCard({
          id: 'tui:local',
          sessionId: 'tui:local',
          model: 'openai-codex/gpt-5.3-codex',
          status: 'idle',
          lastActive: '2026-03-12T10:05:00.000Z',
          messageCount: 4,
        }),
        makeSessionCard({
          id: 'dm:1',
          sessionId: 'dm:1',
          model: 'openai-codex/gpt-5.3-codex',
          status: 'active',
          lastActive: '2026-03-12T10:15:00.000Z',
          messageCount: 6,
          toolCalls: 2,
        }),
      ],
      usage: {
        total_input_tokens: 200,
        total_output_tokens: 50,
        total_cost_usd: 1.25,
        total_tool_calls: 7,
      },
    });

    expect(card).toMatchObject({
      id: 'main',
      name: 'Main Agent',
      model: 'gpt-5',
      workspacePath: '/tmp/agents/main/workspace',
      sessionCount: 2,
      activeSessions: 1,
      idleSessions: 1,
      stoppedSessions: 0,
      effectiveModels: ['openai-codex/gpt-5.3-codex'],
      lastActive: '2026-03-12T10:15:00.000Z',
      inputTokens: 200,
      outputTokens: 50,
      costUsd: 1.25,
      messageCount: 10,
      toolCalls: 7,
      recentSessionId: 'dm:1',
      status: 'active',
    });
  });

  test('marks agents with no sessions as unused', async () => {
    const agent: AgentConfig = { id: 'research', name: 'Research' };
    resolveAgentConfigMock.mockReturnValue(agent);
    resolveAgentModelMock.mockReturnValue(undefined);

    const { mapLogicalAgentCard } = await import(
      '../src/gateway/gateway-agent-cards.ts'
    );

    const card = mapLogicalAgentCard({
      agent,
      sessions: [],
    });

    expect(card).toMatchObject({
      id: 'research',
      status: 'unused',
      sessionCount: 0,
      recentSessionId: null,
      effectiveModels: [],
      lastActive: null,
    });
  });

  test('logs debug details when conversation preview skips unsupported roles', async () => {
    const { mapSessionCard } = await import(
      '../src/gateway/gateway-agent-cards.ts'
    );

    getRecentMessagesMock.mockReturnValueOnce([
      {
        id: 1,
        session_id: 'sess-1',
        user_id: 'system',
        username: null,
        role: 'system',
        content: 'system context',
        created_at: '2026-03-12T10:00:00.000Z',
      },
      {
        id: 2,
        session_id: 'sess-1',
        user_id: 'tool',
        username: null,
        role: 'tool',
        content: 'tool output',
        created_at: '2026-03-12T10:01:00.000Z',
      },
    ]);

    const card = mapSessionCard({
      session: {
        id: 'sess-1',
        session_key: 'sess-1',
        main_session_key: 'sess-1',
        is_current: 1,
        guild_id: null,
        channel_id: 'local',
        agent_id: 'main',
        chatbot_id: null,
        model: 'gpt-5',
        enable_rag: 0,
        message_count: 2,
        session_summary: null,
        summary_updated_at: null,
        compaction_count: 0,
        memory_flush_at: null,
        full_auto_enabled: 0,
        full_auto_prompt: null,
        full_auto_started_at: null,
        show_mode: 'all',
        created_at: '2026-03-12T10:00:00.000Z',
        last_active: '2026-03-12T10:01:00.000Z',
        reset_count: 0,
        reset_at: null,
      },
      activeSessionIds: new Set<string>(),
      usageBySession: new Map(),
      sandboxMode: 'host',
    });

    expect(card.lastQuestion).toBeNull();
    expect(card.lastAnswer).toBeNull();
    expect(loggerDebugMock).toHaveBeenCalledWith(
      {
        sessionId: 'sess-1',
        unsupportedRoles: ['system', 'tool'],
        messageCount: 2,
      },
      'Session conversation preview omitted unsupported message roles',
    );
  });
});
