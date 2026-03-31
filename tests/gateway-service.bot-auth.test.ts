import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-bot-auth-',
  cleanup: () => {
    runAgentMock.mockReset();
    vi.doUnmock('../src/providers/hybridai-bots.ts');
  },
});

test('bot list returns an actionable message on HybridAI auth failure', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  initDatabase({ quiet: true });

  vi.doMock('../src/providers/hybridai-bots.ts', () => {
    class HybridAIBotFetchError extends Error {
      status: number;
      code?: number | string;
      type?: string;
      constructor(params: {
        status: number;
        message: string;
        code?: number | string;
        type?: string;
      }) {
        super(params.message);
        this.name = 'HybridAIBotFetchError';
        this.status = params.status;
        this.code = params.code;
        this.type = params.type;
      }
    }

    return {
      HybridAIBotFetchError,
      fetchHybridAIAccountChatbotId: vi.fn(async () => 'user-fallback'),
      fetchHybridAIBots: vi.fn(async () => {
        throw new HybridAIBotFetchError({
          status: 401,
          code: 401,
          type: 'authentication_error',
          message: 'Invalid API key provided',
        });
      }),
    };
  });

  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const result = await handleGatewayCommand({
    sessionId: 'session-bot-auth',
    guildId: null,
    channelId: 'channel-bot-auth',
    args: ['bot', 'list'],
  });

  expect(result.kind).toBe('error');
  if (result.kind !== 'error') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.text).toContain(
    'HybridAI rejected the configured API key: Invalid API key provided.',
  );
  expect(result.text).toContain('Update `HYBRIDAI_API_KEY`');
  expect(result.text).toContain('restart the gateway');
});

test('bot set fails fast on HybridAI auth failure without mutating session state', async () => {
  setupHome();

  const { getRecentStructuredAuditForSession, getSessionById, initDatabase } =
    await import('../src/memory/db.ts');
  initDatabase({ quiet: true });

  vi.doMock('../src/providers/hybridai-bots.ts', () => {
    class HybridAIBotFetchError extends Error {
      status: number;
      code?: number | string;
      type?: string;
      constructor(params: {
        status: number;
        message: string;
        code?: number | string;
        type?: string;
      }) {
        super(params.message);
        this.name = 'HybridAIBotFetchError';
        this.status = params.status;
        this.code = params.code;
        this.type = params.type;
      }
    }

    return {
      HybridAIBotFetchError,
      fetchHybridAIAccountChatbotId: vi.fn(async () => 'user-fallback'),
      fetchHybridAIBots: vi.fn(async () => {
        throw new HybridAIBotFetchError({
          status: 401,
          code: 401,
          type: 'authentication_error',
          message: 'Invalid API key provided',
        });
      }),
    };
  });

  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const result = await handleGatewayCommand({
    sessionId: 'session-bot-set-auth',
    guildId: null,
    channelId: 'channel-bot-set-auth',
    args: ['bot', 'set', 'Research Bot'],
  });

  expect(result.kind).toBe('error');
  if (result.kind !== 'error') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.text).toContain(
    'HybridAI rejected the configured API key: Invalid API key provided.',
  );
  expect(result.text).toContain('Update `HYBRIDAI_API_KEY`');
  expect(getSessionById('session-bot-set-auth')?.chatbot_id).toBeNull();
  expect(getSessionById('session-bot-set-auth')?.model).toBeNull();
  expect(
    getRecentStructuredAuditForSession('session-bot-set-auth', 10),
  ).toEqual([]);
});

test('handleGatewayMessage falls back to /bot-management/me when no chatbot is configured', async () => {
  setupHome();

  const fetchHybridAIAccountChatbotId = vi.fn(async () => 'user-42');
  vi.doMock('../src/providers/hybridai-bots.ts', () => ({
    HybridAIBotFetchError: class HybridAIBotFetchError extends Error {},
    fetchHybridAIAccountChatbotId,
    fetchHybridAIBots: vi.fn(async () => []),
  }));

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'Hello from the fallback chatbot.',
    toolsUsed: [],
    toolExecutions: [],
  });

  const { getSessionById, initDatabase } = await import('../src/memory/db.ts');
  initDatabase({ quiet: true });

  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const result = await handleGatewayMessage({
    sessionId: 'session-chatbot-fallback',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'alice',
    content: 'Say hello',
    model: 'gpt-5-nano',
  });

  expect(result.status).toBe('success');
  expect(fetchHybridAIAccountChatbotId).toHaveBeenCalledTimes(1);
  expect(runAgentMock).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: 'session-chatbot-fallback',
      chatbotId: 'user-42',
      model: 'gpt-5-nano',
    }),
  );
  expect(getSessionById('session-chatbot-fallback')?.chatbot_id).toBe(
    'user-42',
  );

  await handleGatewayMessage({
    sessionId: 'session-chatbot-fallback',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'alice',
    content: 'Say hello again',
    model: 'gpt-5-nano',
  });

  expect(fetchHybridAIAccountChatbotId).toHaveBeenCalledTimes(1);
  expect(runAgentMock).toHaveBeenLastCalledWith(
    expect.objectContaining({
      sessionId: 'session-chatbot-fallback',
      chatbotId: 'user-42',
      model: 'gpt-5-nano',
    }),
  );
});

test('handleGatewayMessage returns an auth error when /bot-management/me fallback fails', async () => {
  setupHome();

  vi.doMock('../src/providers/hybridai-bots.ts', () => {
    class HybridAIBotFetchError extends Error {
      status: number;
      code?: number | string;
      type?: string;
      constructor(params: {
        status: number;
        message: string;
        code?: number | string;
        type?: string;
      }) {
        super(params.message);
        this.name = 'HybridAIBotFetchError';
        this.status = params.status;
        this.code = params.code;
        this.type = params.type;
      }
    }

    return {
      HybridAIBotFetchError,
      fetchHybridAIAccountChatbotId: vi.fn(async () => {
        throw new HybridAIBotFetchError({
          status: 401,
          code: 401,
          type: 'authentication_error',
          message: 'Invalid API key provided',
        });
      }),
      fetchHybridAIBots: vi.fn(async () => []),
    };
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  initDatabase({ quiet: true });

  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const result = await handleGatewayMessage({
    sessionId: 'session-chatbot-fallback-auth-error',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'alice',
    content: 'Say hello',
    model: 'gpt-5-nano',
  });

  expect(result).toMatchObject({
    status: 'error',
    result: null,
  });
  expect(result.error).toContain(
    'HybridAI rejected the configured API key: Invalid API key provided.',
  );
  expect(runAgentMock).not.toHaveBeenCalled();
});

test('bot list works even when the session model is not HybridAI', async () => {
  setupHome();

  const fetchHybridAIBots = vi.fn(async () => [
    {
      id: 'bot-research',
      name: 'Research Bot',
      model: 'gpt-4o-mini',
    },
  ]);
  vi.doMock('../src/providers/hybridai-bots.ts', () => ({
    HybridAIBotFetchError: class HybridAIBotFetchError extends Error {},
    fetchHybridAIAccountChatbotId: vi.fn(async () => 'user-fallback'),
    fetchHybridAIBots,
  }));

  const {
    getOrCreateSession,
    getRecentStructuredAuditForSession,
    getSessionById,
    initDatabase,
    updateSessionModel,
  } = await import('../src/memory/db.ts');
  initDatabase({ quiet: true });

  const sessionId = 'session-bot-list-non-hybridai';
  getOrCreateSession(sessionId, null, 'channel-bot-list-non-hybridai');
  updateSessionModel(sessionId, 'openai-codex/gpt-5.4');

  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const result = await handleGatewayCommand({
    sessionId,
    guildId: null,
    channelId: 'channel-bot-list-non-hybridai',
    args: ['bot', 'list'],
  });

  expect(result).toMatchObject({
    kind: 'info',
    title: 'Available Bots',
  });
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.text).toContain('Research Bot (bot-research)');
  expect(result.text).toContain('[hybridai/gpt-4o-mini]');
  expect(fetchHybridAIBots).toHaveBeenCalledTimes(1);
  expect(getRecentStructuredAuditForSession(sessionId, 10)).toEqual([]);
  expect(getSessionById(sessionId)?.chatbot_id).toBeNull();
});

test('bot set works from a non-HybridAI session and syncs the bot model', async () => {
  setupHome();

  vi.doMock('../src/providers/hybridai-bots.ts', () => ({
    HybridAIBotFetchError: class HybridAIBotFetchError extends Error {},
    fetchHybridAIAccountChatbotId: vi.fn(async () => 'user-fallback'),
    fetchHybridAIBots: vi.fn(async () => [
      {
        id: 'bot-research',
        name: 'Research Bot',
        model: 'gpt-4o-mini',
      },
    ]),
  }));

  const {
    getOrCreateSession,
    getSessionById,
    initDatabase,
    updateSessionModel,
  } = await import('../src/memory/db.ts');
  initDatabase({ quiet: true });

  const sessionId = 'session-bot-set-non-hybridai';
  getOrCreateSession(sessionId, null, 'channel-bot-set-non-hybridai');
  updateSessionModel(sessionId, 'openai-codex/gpt-5.4');

  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const result = await handleGatewayCommand({
    sessionId,
    guildId: null,
    channelId: 'channel-bot-set-non-hybridai',
    args: ['bot', 'set', 'Research Bot'],
  });

  expect(result).toMatchObject({
    kind: 'plain',
    text: 'Chatbot set to `bot-research` and model set to `hybridai/gpt-4o-mini` for this session.',
  });
  expect(getSessionById(sessionId)?.chatbot_id).toBe('bot-research');
  expect(getSessionById(sessionId)?.model).toBe('gpt-4o-mini');
});

test('bot info works even when the session model is not HybridAI', async () => {
  setupHome();

  vi.doMock('../src/providers/hybridai-bots.ts', () => ({
    HybridAIBotFetchError: class HybridAIBotFetchError extends Error {},
    fetchHybridAIAccountChatbotId: vi.fn(async () => 'user-fallback'),
    fetchHybridAIBots: vi.fn(async () => [
      {
        id: 'bot-research',
        name: 'Research Bot',
        model: 'gpt-4o-mini',
      },
    ]),
  }));

  const {
    getOrCreateSession,
    initDatabase,
    updateSessionChatbot,
    updateSessionModel,
  } = await import('../src/memory/db.ts');
  initDatabase({ quiet: true });

  const sessionId = 'session-bot-info-non-hybridai';
  getOrCreateSession(sessionId, null, 'channel-bot-info-non-hybridai');
  updateSessionModel(sessionId, 'openai-codex/gpt-5.4');
  updateSessionChatbot(sessionId, 'bot-research');

  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const result = await handleGatewayCommand({
    sessionId,
    guildId: null,
    channelId: 'channel-bot-info-non-hybridai',
    args: ['bot', 'info'],
  });

  expect(result).toMatchObject({
    kind: 'info',
    title: 'Bot Info',
  });
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.text).toContain('Chatbot: Research Bot (bot-research)');
  expect(result.text).toContain('Bot Model: hybridai/gpt-4o-mini');
  expect(result.text).toContain('Model: openai-codex/gpt-5.4');
});

test('bot list returns a short message when HybridAI is unreachable', async () => {
  setupHome();

  vi.doMock('../src/providers/hybridai-bots.ts', () => {
    class HybridAIBotFetchError extends Error {
      status: number;
      code?: number | string;
      type?: string;
      constructor(params: {
        status: number;
        message: string;
        code?: number | string;
        type?: string;
      }) {
        super(params.message);
        this.name = 'HybridAIBotFetchError';
        this.status = params.status;
        this.code = params.code;
        this.type = params.type;
      }
    }

    return {
      HybridAIBotFetchError,
      fetchHybridAIAccountChatbotId: vi.fn(async () => 'user-fallback'),
      fetchHybridAIBots: vi.fn(async () => {
        throw new HybridAIBotFetchError({
          status: 0,
          type: 'network_error',
          message: 'fetch failed (connect ECONNREFUSED 127.0.0.1:5000)',
        });
      }),
    };
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  initDatabase({ quiet: true });

  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { HYBRIDAI_BASE_URL } = await import('../src/config/config.ts');
  const result = await handleGatewayCommand({
    sessionId: 'session-bot-network-failure',
    guildId: null,
    channelId: 'channel-bot-network-failure',
    args: ['bot', 'list'],
  });

  expect(result.kind).toBe('error');
  if (result.kind !== 'error') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.text).toBe(
    `HybridAI is not reachable at \`${HYBRIDAI_BASE_URL}\`. Check \`hybridai.baseUrl\` and confirm the HybridAI service is running.`,
  );
});

test('bot list suggests http when HybridAI baseUrl uses https for a local non-TLS server', async () => {
  setupHome();

  vi.doMock('../src/providers/hybridai-bots.ts', () => {
    class HybridAIBotFetchError extends Error {
      status: number;
      code?: number | string;
      type?: string;
      constructor(params: {
        status: number;
        message: string;
        code?: number | string;
        type?: string;
      }) {
        super(params.message);
        this.name = 'HybridAIBotFetchError';
        this.status = params.status;
        this.code = params.code;
        this.type = params.type;
      }
    }

    return {
      HybridAIBotFetchError,
      fetchHybridAIAccountChatbotId: vi.fn(async () => 'user-fallback'),
      fetchHybridAIBots: vi.fn(async () => {
        throw new HybridAIBotFetchError({
          status: 0,
          type: 'network_error',
          message:
            'fetch failed (8030010002000000:error:0A00010B:SSL routines:ssl3_get_record:wrong version number)',
        });
      }),
    };
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  initDatabase({ quiet: true });

  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { HYBRIDAI_BASE_URL } = await import('../src/config/config.ts');
  const result = await handleGatewayCommand({
    sessionId: 'session-bot-network-ssl-failure',
    guildId: null,
    channelId: 'channel-bot-network-ssl-failure',
    args: ['bot', 'list'],
  });

  expect(result.kind).toBe('error');
  if (result.kind !== 'error') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  const insecureBaseUrl = HYBRIDAI_BASE_URL.replace(/^https:/i, 'http:');
  expect(result.text).toBe(
    `HybridAI is not reachable at \`${HYBRIDAI_BASE_URL}\`. If this local HybridAI server does not use TLS, run \`hybridclaw auth login hybridai --base-url ${insecureBaseUrl}\`.`,
  );
});

test('bot list error uses HYBRIDAI_BASE_URL from env when present', async () => {
  setupHome({ HYBRIDAI_BASE_URL: 'https://preview-pr-123.example.com' });

  vi.doMock('../src/providers/hybridai-bots.ts', () => {
    class HybridAIBotFetchError extends Error {
      status: number;
      code?: number | string;
      type?: string;
      constructor(params: {
        status: number;
        message: string;
        code?: number | string;
        type?: string;
      }) {
        super(params.message);
        this.name = 'HybridAIBotFetchError';
        this.status = params.status;
        this.code = params.code;
        this.type = params.type;
      }
    }

    return {
      HybridAIBotFetchError,
      fetchHybridAIAccountChatbotId: vi.fn(async () => 'user-fallback'),
      fetchHybridAIBots: vi.fn(async () => {
        throw new HybridAIBotFetchError({
          status: 0,
          type: 'network_error',
          message: 'fetch failed (connect ECONNREFUSED 10.0.0.1:443)',
        });
      }),
    };
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  initDatabase({ quiet: true });

  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const result = await handleGatewayCommand({
    sessionId: 'session-bot-env-base-url',
    guildId: null,
    channelId: 'channel-bot-env-base-url',
    args: ['bot', 'list'],
  });

  expect(result.kind).toBe('error');
  if (result.kind !== 'error') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.text).toBe(
    'HybridAI is not reachable at `https://preview-pr-123.example.com`. Check `hybridai.baseUrl` and confirm the HybridAI service is running.',
  );
});

test('bot list still classifies generic auth errors without HybridAIBotFetchError metadata', async () => {
  setupHome();

  vi.doMock('../src/providers/hybridai-bots.ts', () => ({
    HybridAIBotFetchError: class HybridAIBotFetchError extends Error {},
    fetchHybridAIAccountChatbotId: vi.fn(async () => 'user-fallback'),
    fetchHybridAIBots: vi.fn(async () => {
      throw new Error('Invalid API key provided');
    }),
  }));

  const { initDatabase } = await import('../src/memory/db.ts');
  initDatabase({ quiet: true });

  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const result = await handleGatewayCommand({
    sessionId: 'session-bot-generic-auth-failure',
    guildId: null,
    channelId: 'channel-bot-generic-auth-failure',
    args: ['bot', 'list'],
  });

  expect(result.kind).toBe('error');
  if (result.kind !== 'error') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.text).toContain(
    'HybridAI rejected the configured API key: Invalid API key provided.',
  );
  expect(result.text).toContain('Update `HYBRIDAI_API_KEY`');
});
