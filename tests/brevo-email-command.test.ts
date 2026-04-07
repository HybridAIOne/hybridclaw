import { beforeEach, expect, test, vi } from 'vitest';

const {
  getSessionByIdMock,
  unsetPluginConfigValueMock,
  writePluginConfigValueMock,
} = vi.hoisted(() => ({
  getSessionByIdMock: vi.fn(),
  unsetPluginConfigValueMock: vi.fn(),
  writePluginConfigValueMock: vi.fn(),
}));

vi.mock('../src/memory/db.js', () => ({
  getSessionById: getSessionByIdMock,
}));

vi.mock('../src/plugins/plugin-config.js', () => ({
  unsetPluginConfigValue: unsetPluginConfigValueMock,
  writePluginConfigValue: writePluginConfigValueMock,
}));

import { createBrevoCommandHandler } from '../plugins/brevo-email/src/brevo-command.js';

function makeJsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name: string) {
        return name.toLowerCase() === 'content-type'
          ? 'application/json'
          : null;
      },
    },
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

beforeEach(() => {
  getSessionByIdMock.mockReset();
  unsetPluginConfigValueMock.mockReset();
  writePluginConfigValueMock.mockReset();
  writePluginConfigValueMock.mockResolvedValue({
    pluginId: 'brevo-email',
    key: 'agentHandles',
    value: { writer: 'steve-cf4' },
    changed: true,
    removed: false,
    configPath: '/tmp/home/.hybridclaw/config.json',
    entry: null,
  });
  unsetPluginConfigValueMock.mockResolvedValue({
    pluginId: 'brevo-email',
    key: 'agentHandles',
    value: undefined,
    changed: true,
    removed: true,
    configPath: '/tmp/home/.hybridclaw/config.json',
    entry: null,
  });
});

test('brevo attach validates the handle and persists it for the current agent', async () => {
  getSessionByIdMock.mockReturnValue({ agent_id: 'writer' });
  const fetchImpl = vi.fn(async () =>
    makeJsonResponse({
      handles: [
        {
          id: 1,
          handle: 'steve-cf4',
          status: 'active',
        },
      ],
      count: 1,
    }),
  );
  const api = {
    pluginId: 'brevo-email',
    getCredential: vi.fn((key: string) =>
      key === 'HYBRIDAI_API_KEY' ? 'hai-test-key' : undefined,
    ),
    config: {
      hybridai: {
        baseUrl: 'https://hybridai.one',
      },
      agents: {
        defaultAgentId: 'main',
      },
    },
  };
  const config = {
    domain: 'agent.hybridai.one',
    fromAddress: '',
    agentHandles: {},
  };

  const handler = createBrevoCommandHandler(api as never, config, {
    fetchImpl,
  });
  const result = await handler(['attach', 'steve-cf4'], {
    sessionId: 'session-1',
    channelId: 'web',
    guildId: null,
  });

  expect(fetchImpl).toHaveBeenCalledWith(
    'https://hybridai.one/api/v1/agent-handles/',
    expect.objectContaining({
      headers: {
        Authorization: 'Bearer hai-test-key',
      },
    }),
  );
  expect(writePluginConfigValueMock).toHaveBeenCalledWith(
    'brevo-email',
    'agentHandles',
    JSON.stringify({ writer: 'steve-cf4' }),
  );
  expect(config.agentHandles).toEqual({ writer: 'steve-cf4' });
  expect(result).toContain('Brevo handle attached.');
  expect(result).toContain('Agent: writer');
  expect(result).toContain('Email address: steve-cf4@agent.hybridai.one');
});

test('brevo detach removes the current agent handle mapping', async () => {
  getSessionByIdMock.mockReturnValue({ agent_id: 'writer' });
  const api = {
    pluginId: 'brevo-email',
    getCredential: vi.fn(),
    config: {
      agents: {
        defaultAgentId: 'main',
      },
    },
  };
  const config = {
    domain: 'agent.hybridai.one',
    fromAddress: '',
    agentHandles: {
      writer: 'steve-cf4',
    },
  };

  const handler = createBrevoCommandHandler(api as never, config);
  const result = await handler(['detach'], {
    sessionId: 'session-1',
    channelId: 'tui',
    guildId: null,
  });

  expect(unsetPluginConfigValueMock).toHaveBeenCalledWith(
    'brevo-email',
    'agentHandles',
  );
  expect(config.agentHandles).toEqual({});
  expect(result).toContain('Brevo handle detached.');
  expect(result).toContain('Previous handle: steve-cf4');
  expect(result).toContain('Email address: writer@agent.hybridai.one');
});
