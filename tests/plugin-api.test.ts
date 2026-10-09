import fs from 'node:fs';
import path from 'node:path';

import { expect, test, vi } from 'vitest';
import type { RuntimeConfig } from '../src/config/runtime-config.js';
import * as ipc from '../src/infra/ipc.js';
import * as db from '../src/memory/db.js';
import { createPluginApi } from '../src/plugins/plugin-api.js';
import type { PluginManager } from '../src/plugins/plugin-manager.js';

function loadRuntimeConfig(): RuntimeConfig {
  return JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'config.example.json'), 'utf-8'),
  ) as RuntimeConfig;
}

function makePluginManagerStub(
  overrides: Partial<PluginManager> = {},
): PluginManager {
  return {
    registerMemoryLayer() {},
    registerProvider() {},
    registerChannel() {},
    registerTool() {},
    registerPromptHook() {},
    registerMiddleware() {},
    registerCommand() {},
    registerService() {},
    registerInboundWebhook() {},
    dispatchInboundMessage() {
      return Promise.resolve({
        status: 'success',
        result: 'ok',
        toolsUsed: [],
      });
    },
    registerHook() {},
    getSessionWorkspaceRoot() {
      return null;
    },
    getSessionUserId() {
      return null;
    },
    ...overrides,
  } as unknown as PluginManager;
}

test('createPluginApi exposes immutable config snapshots without freezing caller inputs', () => {
  const config = loadRuntimeConfig();
  const pluginConfig = {
    workspaceId: 'workspace-1',
    nested: {
      enabled: true,
    },
  };
  const originalPluginList = structuredClone(config.plugins.list);

  const api = createPluginApi({
    manager: makePluginManagerStub(),
    pluginId: 'demo-plugin',
    pluginDir: '/tmp/demo-plugin',
    registrationMode: 'full',
    config,
    pluginConfig,
    declaredEnv: [],
    homeDir: '/tmp/home',
    cwd: '/tmp/project',
  });

  expect(Object.isFrozen(api)).toBe(true);
  expect(Object.isFrozen(api.config)).toBe(true);
  expect(Object.isFrozen(api.config.plugins)).toBe(true);
  expect(Object.isFrozen(api.pluginConfig)).toBe(true);
  expect(
    Object.isFrozen(
      (
        api.pluginConfig as {
          nested: {
            enabled: boolean;
          };
        }
      ).nested,
    ),
  ).toBe(true);
  expect(Object.isFrozen(config)).toBe(false);
  expect(api.config).not.toBe(config);
  expect(api.pluginConfig).not.toBe(pluginConfig);
  expect(
    (
      api.pluginConfig as {
        nested: {
          enabled: boolean;
        };
      }
    ).nested,
  ).not.toBe(pluginConfig.nested);

  config.plugins.list.push({
    id: 'mutated-plugin',
    enabled: false,
    config: {},
  });
  pluginConfig.nested.enabled = false;

  expect(api.config.plugins.list).toEqual(originalPluginList);
  expect(
    (
      api.pluginConfig as {
        nested: {
          enabled: boolean;
        };
      }
    ).nested.enabled,
  ).toBe(true);

  expect(() => {
    (
      api.pluginConfig as {
        nested: {
          enabled: boolean;
        };
      }
    ).nested.enabled = false;
  }).toThrow(TypeError);
});

test('createPluginApi only exposes manifest-declared credentials', () => {
  const allowedKey = 'HYBRIDCLAW_PLUGIN_ALLOWED_TEST';
  const blockedKey = 'HYBRIDCLAW_PLUGIN_BLOCKED_TEST';
  const originalAllowed = process.env[allowedKey];
  const originalBlocked = process.env[blockedKey];
  process.env[allowedKey] = 'allowed-secret';
  process.env[blockedKey] = 'blocked-secret';

  try {
    const api = createPluginApi({
      manager: makePluginManagerStub(),
      pluginId: 'demo-plugin',
      pluginDir: '/tmp/demo-plugin',
      registrationMode: 'full',
      config: loadRuntimeConfig(),
      pluginConfig: {},
      declaredEnv: [allowedKey],
      homeDir: '/tmp/home',
      cwd: '/tmp/project',
    });

    expect(api.getCredential(allowedKey)).toBe('allowed-secret');
    expect(api.getCredential(` ${allowedKey} `)).toBe('allowed-secret');
    expect(api.getCredential(blockedKey)).toBeUndefined();
    expect(api.getCredential('')).toBeUndefined();
    expect(
      api.resolveSessionAgentId('agent:writer:channel:tui:chat:dm:peer:local'),
    ).toBe('writer');
  } finally {
    if (originalAllowed === undefined) {
      delete process.env[allowedKey];
    } else {
      process.env[allowedKey] = originalAllowed;
    }
    if (originalBlocked === undefined) {
      delete process.env[blockedKey];
    } else {
      process.env[blockedKey] = originalBlocked;
    }
  }
});

test('createPluginApi delegates inbound webhook registration and inbound turn dispatch', async () => {
  const registerInboundWebhook = vi.fn();
  const dispatchInboundMessage = vi.fn(async () => ({
    status: 'success' as const,
    result: 'reply',
    toolsUsed: [],
    sessionId: 'session-2',
  }));
  const manager = {
    registerMemoryLayer() {},
    registerProvider() {},
    registerChannel() {},
    registerTool() {},
    registerPromptHook() {},
    registerMiddleware() {},
    registerCommand() {},
    registerService() {},
    registerInboundWebhook,
    dispatchInboundMessage,
    registerHook() {},
  } as unknown as PluginManager;

  const api = createPluginApi({
    manager,
    pluginId: 'demo-plugin',
    pluginDir: '/tmp/demo-plugin',
    registrationMode: 'full',
    config: loadRuntimeConfig(),
    pluginConfig: {},
    declaredEnv: [],
    homeDir: '/tmp/home',
    cwd: '/tmp/project',
  });

  const handler = vi.fn();
  api.registerInboundWebhook({
    name: 'inbound',
    handler,
  });
  const result = await api.dispatchInboundMessage({
    sessionId: 'session-2',
    guildId: null,
    channelId: 'email:user@example.com',
    userId: 'user@example.com',
    username: 'User',
    content: 'Hello',
  });

  expect(registerInboundWebhook).toHaveBeenCalledWith('demo-plugin', {
    name: 'inbound',
    handler,
  });
  expect(dispatchInboundMessage).toHaveBeenCalledWith('demo-plugin', {
    sessionId: 'session-2',
    guildId: null,
    channelId: 'email:user@example.com',
    userId: 'user@example.com',
    username: 'User',
    content: 'Hello',
  });
  expect(result).toEqual(
    expect.objectContaining({
      status: 'success',
      result: 'reply',
      sessionId: 'session-2',
    }),
  );
});

test('createPluginApi derives session info from stored session and cached session user id', () => {
  vi.spyOn(db, 'getSessionById').mockReturnValue({
    agent_id: 'writer',
  } as never);
  const getRecentMessagesSpy = vi.spyOn(db, 'getRecentMessages');
  vi.spyOn(ipc, 'agentWorkspaceDir').mockReturnValue(
    '/tmp/home/data/agents/writer/workspace',
  );

  const api = createPluginApi({
    manager: makePluginManagerStub({
      getSessionUserId() {
        return 'user-42';
      },
      getSessionWorkspaceRoot() {
        return '/tmp/project/clients/client-alpha';
      },
    }),
    pluginId: 'demo-plugin',
    pluginDir: '/tmp/demo-plugin',
    registrationMode: 'full',
    config: loadRuntimeConfig(),
    pluginConfig: {},
    declaredEnv: [],
    homeDir: '/tmp/home',
    cwd: '/tmp/project',
  });

  expect(api.getSessionInfo('session-42')).toEqual({
    sessionId: 'session-42',
    agentId: 'writer',
    userId: 'user-42',
    workspacePath: '/tmp/home/data/agents/writer/workspace',
    workspaceRoot: '/tmp/project/clients/client-alpha',
  });
  expect(getRecentMessagesSpy).not.toHaveBeenCalled();
});

test('createPluginApi exposes immutable stored session messages', () => {
  vi.spyOn(db, 'getRecentMessages').mockReturnValue([
    {
      id: 1,
      session_id: 'session-7',
      role: 'user',
      content: 'Earlier turn',
    },
  ] as never);

  const api = createPluginApi({
    manager: makePluginManagerStub(),
    pluginId: 'demo-plugin',
    pluginDir: '/tmp/demo-plugin',
    registrationMode: 'full',
    config: loadRuntimeConfig(),
    pluginConfig: {},
    declaredEnv: [],
    homeDir: '/tmp/home',
    cwd: '/tmp/project',
  });

  const messages = api.getSessionMessages('session-7');

  expect(db.getRecentMessages).toHaveBeenCalledWith('session-7', undefined);
  expect(messages).toEqual([
    {
      id: 1,
      session_id: 'session-7',
      role: 'user',
      content: 'Earlier turn',
    },
  ]);
  expect(() => {
    (
      messages as Array<{
        content: string;
      }>
    )[0].content = 'Mutated';
  }).toThrow(TypeError);
});

test('live routing reads are immutable and independent of registration snapshots', () => {
  const config = loadRuntimeConfig();
  let routing = { ...config.routing, enabled: false };
  const api = createPluginApi({
    manager: makePluginManagerStub({ getRoutingConfig: () => routing }),
    pluginId: 'tier-router', pluginDir: '/tmp/tier-router', registrationMode: 'full',
    config, pluginConfig: {}, declaredEnv: [], homeDir: '/tmp/home', cwd: '/tmp/project',
  });
  const before = api.getRoutingConfig();
  routing = { ...routing, enabled: true, tiers: [{ name: 'test', models: ['local/test'] }] };
  const after = api.getRoutingConfig();
  expect(before.enabled).toBe(false);
  expect(after.enabled).toBe(true);
  expect(Object.isFrozen(after.tiers[0].models)).toBe(true);
  expect(() => after.tiers[0].models.push('local/other')).toThrow();
  expect(routing.tiers[0].models).toEqual(['local/test']);
  expect(Object.isFrozen(routing)).toBe(false);
});

function createVoiceTransportApi(
  config: RuntimeConfig,
  dispatchInboundMessage?: PluginManager['dispatchInboundMessage'],
) {
  return createPluginApi({
    manager: makePluginManagerStub({
      getConfig: () => config,
      ...(dispatchInboundMessage ? { dispatchInboundMessage } : {}),
    }),
    pluginId: 'twilio-voice',
    pluginDir: '/tmp/twilio-voice',
    registrationMode: 'full',
    config,
    pluginConfig: {},
    declaredEnv: [],
    homeDir: '/tmp/home',
    cwd: '/tmp/project',
  });
}

test('getVoiceConfig and getPublicBaseUrl read the live config, frozen', () => {
  const config = loadRuntimeConfig();
  config.ops.gatewayBaseUrl = 'http://127.0.0.1:9090';
  config.deployment.mode = 'local';
  const api = createVoiceTransportApi(config);

  config.voice.enabled = true;
  config.voice.callerPolicy = 'allowlist';

  expect(api.getVoiceConfig()).toMatchObject({
    enabled: true,
    callerPolicy: 'allowlist',
  });
  expect(Object.isFrozen(api.getVoiceConfig().twilio)).toBe(true);
  expect(api.getPublicBaseUrl()).toBeNull();
  config.ops.gatewayBaseUrl = 'https://voice.example.com/';
  expect(api.getPublicBaseUrl()).toBe('https://voice.example.com');
});

test.each([
  { defaultAgentId: 'support', listed: true, expected: 'support' },
  { defaultAgentId: 'ghost', listed: false, expected: 'main' },
])('getDefaultAgentId reads the live default: $defaultAgentId', ({
  defaultAgentId,
  listed,
  expected,
}) => {
  const config = loadRuntimeConfig();
  const api = createVoiceTransportApi(config);

  config.agents = {
    ...config.agents,
    defaultAgentId,
    list: listed ? [{ id: defaultAgentId }] : [],
  };

  expect(api.config.agents?.defaultAgentId).not.toBe(defaultAgentId);
  expect(api.getDefaultAgentId()).toBe(expected);
});

test('formatTextForSpeech rewrites markdown for TTS', () => {
  const api = createVoiceTransportApi(loadRuntimeConfig());

  expect(api.formatTextForSpeech('**Yes**. See [docs](https://x.test).')).toBe(
    'Yes. See docs.',
  );
});

test.each([
  {
    deltas: ['__MESSAGE_', 'SEND_HANDLED__'],
    result: '__MESSAGE_SEND_HANDLED__',
    spoken: '',
  },
  { deltas: ['Sent ', 'it.'], result: 'Sent it.', spoken: 'Sent it.' },
])(
  'streaming plugin dispatch hides a silent reply: $result',
  async ({ deltas, result, spoken }) => {
    const streamed: string[] = [];
    const api = createVoiceTransportApi(
      loadRuntimeConfig(),
      async (_pluginId, request) => {
        for (const delta of deltas) request.onTextDelta?.(delta);
        return { status: 'success', result, toolsUsed: [] };
      },
    );

    const dispatched = await api.dispatchInboundMessage({
      sessionId: 'agent:main:channel:voice:chat:dm:peer:CA1',
      guildId: null,
      channelId: 'voice:CA1',
      userId: '+15550001111',
      username: null,
      content: 'send it',
      onTextDelta: (delta) => streamed.push(delta),
    });

    expect(streamed.join('')).toBe(spoken);
    expect(dispatched.result).toBe(spoken);
  },
);
