import { expect, test, vi } from 'vitest';
import type { AgentProxyConfig } from '../src/agents/agent-types.ts';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-proxy-agent-',
  cleanup: () => {
    runAgentMock.mockReset();
  },
});

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    {
      headers: {
        'content-type': 'text/event-stream',
      },
    },
  );
}

function proxyConfig(params?: {
  apiKey?: unknown;
  baseUrl?: string;
  conversationScope?: 'channel' | 'user';
}): AgentProxyConfig {
  return {
    kind: 'hybridai',
    baseUrl: params?.baseUrl ?? 'https://app.hybridai.one',
    chatbotId: 'bot_abc123',
    apiKey: params?.apiKey ?? '<secret:HYBRIDAI_API_KEY>',
    ...(params?.conversationScope
      ? { conversationScope: params.conversationScope }
      : {}),
  } as unknown as AgentProxyConfig;
}

test('agent registry normalizes and persists HybridAI proxy config', async () => {
  setupHome();

  const { initDatabase, getAgentById } = await import('../src/memory/db.ts');
  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  const { initAgentRegistry, resolveAgentConfig } = await import(
    '../src/agents/agent-registry.ts'
  );

  initDatabase({ quiet: true });
  updateRuntimeConfig((draft) => {
    draft.agents.list = [
      {
        id: 'support',
        name: 'Support Proxy',
        proxy: proxyConfig({
          baseUrl: 'https://app.hybridai.one///',
          conversationScope: 'user',
        }),
      },
    ];
  });
  initAgentRegistry({
    list: [
      {
        id: 'support',
        name: 'Support Proxy',
        proxy: proxyConfig({
          baseUrl: 'https://app.hybridai.one///',
          conversationScope: 'user',
        }),
      },
    ],
  });

  const expectedProxy = {
    kind: 'hybridai',
    baseUrl: 'https://app.hybridai.one',
    chatbotId: 'bot_abc123',
    apiKey: { source: 'store', id: 'HYBRIDAI_API_KEY' },
    conversationScope: 'user',
  };
  expect(resolveAgentConfig('support').proxy).toEqual(expectedProxy);
  expect(getAgentById('support')?.proxy).toEqual(expectedProxy);
});

test('agent registry rejects non-HTTPS HybridAI proxy base URLs', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { initAgentRegistry } = await import(
    '../src/agents/agent-registry.ts'
  );

  initDatabase({ quiet: true });
  expect(() =>
    initAgentRegistry({
      list: [
        {
          id: 'support',
          proxy: proxyConfig({
            baseUrl: 'http://app.hybridai.one',
            apiKey: { source: 'store', id: 'HYBRIDAI_API_KEY' },
          }),
        },
      ],
    }),
  ).toThrow('agents.list[].proxy.baseUrl must use HTTPS');
});

test('handleGatewayMessage forwards proxy agents to HybridAI without running local agent pipeline', async () => {
  setupHome();

  const fetchMock = vi.fn(async () =>
    streamResponse([
      'data: {"delta":"Hel"}\n\n',
      'data: {"delta":"lo from HybridAI"}\n\n',
      'data: [DONE]\n\n',
    ]),
  );
  vi.stubGlobal('fetch', fetchMock);

  const { initDatabase, getConversationHistory, getSessionById } =
    await import('../src/memory/db.ts');
  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  const { saveNamedRuntimeSecrets } = await import(
    '../src/security/runtime-secrets.ts'
  );
  const { initAgentRegistry } = await import(
    '../src/agents/agent-registry.ts'
  );
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  initDatabase({ quiet: true });
  saveNamedRuntimeSecrets({
    HYBRIDAI_API_KEY: 'hai-proxy-test-key-1234567890',
  });
  updateRuntimeConfig((draft) => {
    draft.agents.list = [
      {
        id: 'support',
        proxy: proxyConfig({ conversationScope: 'user' }),
      },
    ];
  });
  initAgentRegistry({
    list: [
      {
        id: 'support',
        proxy: proxyConfig({ conversationScope: 'user' }),
      },
    ],
  });

  const deltas: string[] = [];
  const result = await handleGatewayMessage({
    sessionId: 'session-proxy',
    guildId: 'guild-1',
    channelId: 'channel-1',
    userId: '248135798132',
    username: 'ben#1234',
    content: 'Help me',
    agentId: 'support',
    source: 'discord',
    onTextDelta: (delta) => deltas.push(delta),
  });

  expect(result.status).toBe('success');
  expect(result.result).toBe('Hello from HybridAI');
  expect(deltas).toEqual(['Hel', 'lo from HybridAI']);
  expect(runAgentMock).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
    'https://app.hybridai.one/api/v1/gateway/chat',
  );
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
  expect(init.headers).toMatchObject({
    Authorization: 'Bearer hai-proxy-test-key-1234567890',
    'Content-Type': 'application/json',
  });
  expect(JSON.parse(String(init.body))).toEqual({
    chatbot_id: 'bot_abc123',
    message: 'Help me',
    external_user_id: 'discord:248135798132',
    conversation_id: 'session-proxy:discord:248135798132',
    username: 'ben#1234',
    stream: true,
  });
  expect(getSessionById(result.sessionId || 'session-proxy')?.message_count).toBe(
    0,
  );
  expect(getConversationHistory(result.sessionId || 'session-proxy', 10)).toEqual(
    [],
  );
});

test('handleGatewayMessage hides upstream proxy auth failure bodies from the channel', async () => {
  setupHome();

  const fetchMock = vi.fn(
    async () =>
      new Response('tenant ownership check failed for bot_abc123', {
        status: 403,
      }),
  );
  vi.stubGlobal('fetch', fetchMock);

  const { initDatabase } = await import('../src/memory/db.ts');
  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  const { saveNamedRuntimeSecrets } = await import(
    '../src/security/runtime-secrets.ts'
  );
  const { initAgentRegistry } = await import(
    '../src/agents/agent-registry.ts'
  );
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  initDatabase({ quiet: true });
  saveNamedRuntimeSecrets({
    HYBRIDAI_API_KEY: 'hai-proxy-test-key-1234567890',
  });
  updateRuntimeConfig((draft) => {
    draft.agents.list = [
      {
        id: 'support',
        proxy: proxyConfig({
          apiKey: { source: 'store', id: 'HYBRIDAI_API_KEY' },
        }),
      },
    ];
  });
  initAgentRegistry({
    list: [
      {
        id: 'support',
        proxy: proxyConfig({
          apiKey: { source: 'store', id: 'HYBRIDAI_API_KEY' },
        }),
      },
    ],
  });

  const result = await handleGatewayMessage({
    sessionId: 'session-proxy-auth',
    guildId: null,
    channelId: 'channel-1',
    userId: 'user-1',
    username: 'alice',
    content: 'Hello',
    agentId: 'support',
    source: 'slack',
  });

  expect(result.status).toBe('success');
  expect(result.result).toBe(
    'The bot is not reachable because its upstream configuration needs attention.',
  );
  expect(result.result).not.toContain('tenant ownership');
  expect(runAgentMock).not.toHaveBeenCalled();
});
