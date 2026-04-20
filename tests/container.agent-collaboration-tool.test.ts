import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  executeTool,
  setGatewayContext,
  setSessionContext,
} from '../container/src/tools.js';

function mockFetchJson(responsePayload: Record<string, unknown>) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(responsePayload),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe.sequential('container agent collaboration tools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    setSessionContext('');
    setGatewayContext('', '', '');
  });

  test('list_agents reads the gateway agent catalog and returns a simplified result', async () => {
    const fetchMock = mockFetchJson({
      agents: [
        {
          id: 'research',
          name: 'Research Agent',
          model: 'openai-codex/gpt-5.4-mini',
          status: 'idle',
          workspacePath: '/tmp/research',
          sessionCount: 2,
          activeSessions: 1,
        },
      ],
    });
    setGatewayContext('http://gateway.local', 'token', 'web');

    const result = await executeTool('list_agents', JSON.stringify({}));
    const parsed = JSON.parse(result) as {
      success: boolean;
      count: number;
      agents: Array<{ id: string; name: string | null }>;
    };

    expect(parsed.success).toBe(true);
    expect(parsed.count).toBe(1);
    expect(parsed.agents[0]).toMatchObject({
      id: 'research',
      name: 'Research Agent',
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'http://gateway.local/api/agents',
    );
    expect(
      (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.method,
    ).toBe('GET');
  });

  test('chat_with_agent posts the current session and named destination to the gateway', async () => {
    const fetchMock = mockFetchJson({
      status: 'success',
      route: {
        sourceAgentId: 'main',
        targetAgentId: 'research',
        destination: 'planner',
        sessionId:
          'agent:research:channel:agent:chat:dm:peer:main:subagent:planner',
        executionSessionId: 'session-123',
        channelId: 'agent:main:planner',
      },
      result: 'Research summary',
      toolsUsed: ['web_search'],
    });
    setGatewayContext('http://gateway.local', 'token', 'web');
    setSessionContext('session-current');

    const result = await executeTool(
      'chat_with_agent',
      JSON.stringify({
        toAgent: 'research',
        prompt: 'Review the rollout plan.',
        destination: 'planner',
        timeoutSeconds: 42,
      }),
    );

    expect(result).toContain('"status": "success"');
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'http://gateway.local/api/agents/chat',
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(init.body || '{}')) as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({
      currentSessionId: 'session-current',
      toAgent: 'research',
      text: 'Review the rollout plan.',
      destination: 'planner',
      timeoutSeconds: 42,
    });
  });
});
