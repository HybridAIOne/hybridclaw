import { beforeEach, expect, test, vi } from 'vitest';

const {
  resolveSessionAgentIdMock,
  unsetConfigValueMock,
  writeConfigValueMock,
} = vi.hoisted(() => ({
  resolveSessionAgentIdMock: vi.fn(),
  unsetConfigValueMock: vi.fn(),
  writeConfigValueMock: vi.fn(),
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
  resolveSessionAgentIdMock.mockReset();
  unsetConfigValueMock.mockReset();
  writeConfigValueMock.mockReset();
  writeConfigValueMock.mockResolvedValue(undefined);
  unsetConfigValueMock.mockResolvedValue(undefined);
});

test('brevo attach validates the handle and persists it for the current agent', async () => {
  resolveSessionAgentIdMock.mockReturnValue('writer');
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
    resolveSessionAgentId: resolveSessionAgentIdMock,
    writeConfigValue: writeConfigValueMock,
    unsetConfigValue: unsetConfigValueMock,
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
  expect(resolveSessionAgentIdMock).toHaveBeenCalledWith('session-1');
  expect(writeConfigValueMock).toHaveBeenCalledWith(
    'agentHandles',
    JSON.stringify({ writer: 'steve-cf4' }),
  );
  expect(config.agentHandles).toEqual({ writer: 'steve-cf4' });
  expect(result).toContain('Brevo handle attached.');
  expect(result).toContain('Agent: writer');
  expect(result).toContain('Email address: steve-cf4@agent.hybridai.one');
});

test('brevo detach removes the current agent handle mapping', async () => {
  resolveSessionAgentIdMock.mockReturnValue('writer');
  const api = {
    getCredential: vi.fn(),
    resolveSessionAgentId: resolveSessionAgentIdMock,
    writeConfigValue: writeConfigValueMock,
    unsetConfigValue: unsetConfigValueMock,
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

  expect(resolveSessionAgentIdMock).toHaveBeenCalledWith('session-1');
  expect(unsetConfigValueMock).toHaveBeenCalledWith('agentHandles');
  expect(config.agentHandles).toEqual({});
  expect(result).toContain('Brevo handle detached.');
  expect(result).toContain('Previous handle: steve-cf4');
  expect(result).toContain('Email address: writer@agent.hybridai.one');
});
