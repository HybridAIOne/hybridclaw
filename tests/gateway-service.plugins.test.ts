import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const {
  runAgentMock,
  ensurePluginManagerInitializedMock,
  reloadPluginManagerMock,
  shutdownPluginManagerMock,
  installPluginMock,
  readPluginConfigEntryMock,
  readPluginConfigValueMock,
  reinstallPluginMock,
  unsetPluginConfigValueMock,
  uninstallPluginMock,
  pluginManagerMock,
  writePluginConfigValueMock,
} = vi.hoisted(() => {
  const pluginManager = {
    collectPromptContextDetails: vi.fn(async () => ({
      sections: ['plugin-memory-context'],
      pluginIds: ['qmd-memory'],
    })),
    collectPromptContext: vi.fn(async () => ['plugin-memory-context']),
    findCommand: vi.fn(() => undefined),
    getToolDefinitions: vi.fn(() => [
      {
        name: 'memory_lookup',
        description: 'Query plugin memory',
        parameters: {
          type: 'object' as const,
          properties: {
            question: { type: 'string' },
          },
          required: ['question'],
        },
      },
    ]),
    notifyBeforeAgentStart: vi.fn(async () => {}),
    notifyTurnComplete: vi.fn(async () => {}),
    notifyAgentEnd: vi.fn(async () => {}),
    handleSessionReset: vi.fn(async () => {}),
    notifySessionStart: vi.fn(async () => {}),
    listPluginSummary: vi.fn(() => []),
  };
  return {
    runAgentMock: vi.fn(),
    ensurePluginManagerInitializedMock: vi.fn(async () => pluginManager),
    reloadPluginManagerMock: vi.fn(async () => pluginManager),
    shutdownPluginManagerMock: vi.fn(async () => {}),
    installPluginMock: vi.fn(async (source: string) => ({
      pluginId: 'demo-plugin',
      pluginDir: '/tmp/.hybridclaw/plugins/demo-plugin',
      source,
      alreadyInstalled: false,
      dependenciesInstalled: true,
      requiresEnv: ['DEMO_PLUGIN_TOKEN'],
      requiredConfigKeys: ['workspaceId'],
    })),
    readPluginConfigEntryMock: vi.fn((pluginId: string) => ({
      pluginId,
      configPath: '/tmp/config.json',
      entry: {
        id: pluginId,
        enabled: true,
        config: {
          searchMode: 'query',
        },
      },
    })),
    readPluginConfigValueMock: vi.fn((pluginId: string, key: string) => ({
      pluginId,
      key,
      value: 'query',
      configPath: '/tmp/config.json',
      entry: {
        id: pluginId,
        enabled: true,
        config: {
          [key]: 'query',
        },
      },
    })),
    reinstallPluginMock: vi.fn(async (source: string) => ({
      pluginId: 'demo-plugin',
      pluginDir: '/tmp/.hybridclaw/plugins/demo-plugin',
      source,
      alreadyInstalled: false,
      replacedExistingInstall: true,
      dependenciesInstalled: true,
      requiresEnv: ['DEMO_PLUGIN_TOKEN'],
      requiredConfigKeys: ['workspaceId'],
    })),
    uninstallPluginMock: vi.fn(async () => ({
      pluginId: 'demo-plugin',
      pluginDir: '/tmp/.hybridclaw/plugins/demo-plugin',
      removedPluginDir: true,
      removedConfigOverrides: 1,
    })),
    unsetPluginConfigValueMock: vi.fn(
      async (pluginId: string, key: string) => ({
        pluginId,
        key,
        value: undefined,
        changed: true,
        removed: true,
        configPath: '/tmp/config.json',
        entry: null,
      }),
    ),
    writePluginConfigValueMock: vi.fn(
      async (pluginId: string, key: string, rawValue: string) => ({
        pluginId,
        key,
        value: rawValue,
        changed: true,
        removed: false,
        configPath: '/tmp/config.json',
        entry: {
          id: pluginId,
          enabled: true,
          config: {
            [key]: rawValue,
          },
        },
      }),
    ),
    pluginManagerMock: pluginManager,
  };
});

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

vi.mock('../src/plugins/plugin-manager.js', () => ({
  ensurePluginManagerInitialized: ensurePluginManagerInitializedMock,
  reloadPluginManager: reloadPluginManagerMock,
  shutdownPluginManager: shutdownPluginManagerMock,
}));

vi.mock('../src/plugins/plugin-install.js', () => ({
  installPlugin: installPluginMock,
  reinstallPlugin: reinstallPluginMock,
  uninstallPlugin: uninstallPluginMock,
}));

vi.mock('../src/plugins/plugin-config.js', () => ({
  readPluginConfigEntry: readPluginConfigEntryMock,
  readPluginConfigValue: readPluginConfigValueMock,
  unsetPluginConfigValue: unsetPluginConfigValueMock,
  writePluginConfigValue: writePluginConfigValueMock,
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-plugins-',
  cleanup: () => {
    runAgentMock.mockReset();
    ensurePluginManagerInitializedMock.mockClear();
    reloadPluginManagerMock.mockClear();
    pluginManagerMock.collectPromptContextDetails.mockClear();
    pluginManagerMock.collectPromptContext.mockClear();
    pluginManagerMock.getToolDefinitions.mockClear();
    pluginManagerMock.notifyBeforeAgentStart.mockClear();
    pluginManagerMock.notifyTurnComplete.mockClear();
    pluginManagerMock.notifyAgentEnd.mockClear();
    pluginManagerMock.handleSessionReset.mockClear();
    pluginManagerMock.notifySessionStart.mockClear();
    pluginManagerMock.listPluginSummary.mockClear();
    pluginManagerMock.findCommand.mockClear();
    shutdownPluginManagerMock.mockClear();
    installPluginMock.mockClear();
    readPluginConfigEntryMock.mockClear();
    readPluginConfigValueMock.mockClear();
    reinstallPluginMock.mockClear();
    unsetPluginConfigValueMock.mockClear();
    uninstallPluginMock.mockClear();
    writePluginConfigValueMock.mockClear();
  },
});

test('handleGatewayMessage injects plugin prompt context and forwards plugin tools to the agent', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'plugin-aware reply',
    toolsUsed: ['memory_lookup'],
    toolExecutions: [
      {
        name: 'memory_lookup',
        arguments: '{"question":"what matters?"}',
        result: 'long-term summary',
        durationMs: 12,
      },
    ],
  });

  const result = await handleGatewayMessage({
    sessionId: 'session-plugin-test',
    guildId: null,
    channelId: 'web',
    userId: 'user-42',
    username: 'alice',
    content: 'What do you remember about me?',
    model: 'test-model',
    chatbotId: 'bot-1',
  });

  expect(result.status).toBe('success');
  expect(result.pluginsUsed).toEqual(['qmd-memory']);
  const agentMessages = runAgentMock.mock.calls[0]?.[0]?.messages;
  const systemPrompt = agentMessages?.[0]?.content;
  expect(agentMessages?.[0]).toEqual(
    expect.objectContaining({
      role: 'system',
    }),
  );
  expect(systemPrompt).toContain('## Runtime Metadata');
  expect(systemPrompt).toContain('## Runtime Safety Guardrails');
  expect(systemPrompt).toContain('plugin-memory-context');
  expect(pluginManagerMock.collectPromptContextDetails).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: 'session-plugin-test',
      userId: 'user-42',
      agentId: 'main',
      recentMessages: expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: 'What do you remember about me?',
        }),
      ]),
    }),
  );
  expect(runAgentMock).toHaveBeenCalledWith(
    expect.objectContaining({
      pluginTools: [
        expect.objectContaining({
          name: 'memory_lookup',
        }),
      ],
    }),
  );
  expect(pluginManagerMock.notifyBeforeAgentStart).toHaveBeenCalled();
  expect(pluginManagerMock.notifyTurnComplete).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: 'session-plugin-test',
      userId: 'user-42',
      agentId: 'main',
      messages: [
        expect.objectContaining({
          role: 'user',
          content: 'What do you remember about me?',
        }),
        expect.objectContaining({
          role: 'assistant',
          content: 'plugin-aware reply',
        }),
      ],
    }),
  );
  expect(pluginManagerMock.notifyAgentEnd).toHaveBeenCalledWith(
    expect.objectContaining({
      resultText: 'plugin-aware reply',
      toolNames: ['memory_lookup'],
    }),
  );
});

test('handleGatewayMessage continues when plugin session-start hooks stall', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'session-start timeout fallback',
    toolsUsed: [],
    toolExecutions: [],
  });
  pluginManagerMock.notifySessionStart.mockImplementationOnce(
    async () => await new Promise<void>(() => {}),
  );

  const result = await handleGatewayMessage({
    sessionId: 'session-plugin-session-start-timeout',
    guildId: null,
    channelId: 'tui',
    userId: 'user-42',
    username: 'alice',
    content: 'Say hi.',
    model: 'test-model',
    chatbotId: 'bot-1',
  });

  expect(result.status).toBe('success');
  expect(result.result).toBe('session-start timeout fallback');
  expect(runAgentMock).toHaveBeenCalled();
  expect(pluginManagerMock.notifySessionStart).toHaveBeenCalledTimes(1);
});

test('handleGatewayMessage lets plugin prompt context collection use its own timeout budget', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'plugin-context slow success',
    toolsUsed: [],
    toolExecutions: [],
  });
  pluginManagerMock.collectPromptContextDetails.mockImplementationOnce(
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 3_500));
      return {
        sections: ['plugin-memory-context'],
        pluginIds: ['qmd-memory'],
      };
    },
  );

  const result = await handleGatewayMessage({
    sessionId: 'session-plugin-context-timeout',
    guildId: null,
    channelId: 'web',
    userId: 'user-42',
    username: 'alice',
    content: 'What do you remember about me?',
    model: 'test-model',
    chatbotId: 'bot-1',
  });

  expect(result.status).toBe('success');
  expect(result.result).toBe('plugin-context slow success');
  expect(result.pluginsUsed).toEqual(['qmd-memory']);
  const agentMessages = runAgentMock.mock.calls.at(-1)?.[0]?.messages;
  const systemPrompt = agentMessages?.[0]?.content;
  expect(systemPrompt).toContain('plugin-memory-context');
});

test('handleGatewayMessage continues without plugins when plugin manager init fails', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  ensurePluginManagerInitializedMock.mockRejectedValueOnce(
    new Error('plugin init failed'),
  );
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'pluginless reply',
    toolsUsed: [],
    toolExecutions: [],
  });

  const result = await handleGatewayMessage({
    sessionId: 'session-pluginless-test',
    guildId: null,
    channelId: 'web',
    userId: 'user-42',
    username: 'alice',
    content: 'Still answer even if plugins explode.',
    model: 'test-model',
    chatbotId: 'bot-1',
  });

  expect(result.status).toBe('success');
  expect(result.result).toBe('pluginless reply');
  expect(result.pluginsUsed).toEqual([]);
  expect(pluginManagerMock.collectPromptContextDetails).not.toHaveBeenCalled();
  expect(pluginManagerMock.notifyBeforeAgentStart).not.toHaveBeenCalled();
  expect(runAgentMock).toHaveBeenCalledWith(
    expect.objectContaining({
      pluginTools: [],
    }),
  );
});

test('handleGatewayCommand lists plugin summaries', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  pluginManagerMock.listPluginSummary.mockReturnValue([
    {
      id: 'demo-plugin',
      name: 'Demo Plugin',
      version: '1.0.0',
      description: 'Demo plugin for testing',
      source: 'project',
      enabled: true,
      commands: ['demo_status'],
      tools: ['demo_echo'],
      hooks: ['demo-hook'],
    },
    {
      id: 'broken-plugin',
      source: 'home',
      enabled: true,
      error: 'register exploded',
      commands: [],
      tools: [],
      hooks: [],
    },
  ]);

  const result = await handleGatewayCommand({
    sessionId: 'session-plugin-list',
    guildId: null,
    channelId: 'web',
    args: ['plugin', 'list'],
  });

  expect(pluginManagerMock.listPluginSummary).toHaveBeenCalled();
  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Plugins');
  expect(result.text).toContain('demo-plugin v1.0.0 [project]');
  expect(result.text).toContain('description: Demo plugin for testing');
  expect(result.text).toContain('commands: /demo_status');
  expect(result.text).toContain('tools: demo_echo');
  expect(result.text).toContain('broken-plugin [home]');
  expect(result.text).toContain('error: register exploded');
});

test('handleGatewayCommand shows plugin config overrides', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const result = await handleGatewayCommand({
    sessionId: 'session-plugin-config-show',
    guildId: null,
    channelId: 'web',
    args: ['plugin', 'config', 'qmd-memory'],
  });

  expect(readPluginConfigEntryMock).toHaveBeenCalledWith('qmd-memory');
  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Plugin Config');
  expect(result.text).toContain('Plugin: qmd-memory');
  expect(result.text).toContain('Config file: /tmp/config.json');
  expect(result.text).toContain('"searchMode": "query"');
});

test('handleGatewayCommand updates plugin config from a local TUI/web session and reloads plugins', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const result = await handleGatewayCommand({
    sessionId: 'session-plugin-config-set',
    guildId: null,
    channelId: 'tui',
    args: ['plugin', 'config', 'qmd-memory', 'searchMode', 'query'],
  });

  expect(writePluginConfigValueMock).toHaveBeenCalledWith(
    'qmd-memory',
    'searchMode',
    'query',
  );
  expect(reloadPluginManagerMock).toHaveBeenCalled();
  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Plugin Config Updated');
  expect(result.text).toContain('Plugin: qmd-memory');
  expect(result.text).toContain('Key: searchMode');
  expect(result.text).toContain('Value: "query"');
  expect(result.text).toContain('Plugin runtime reloaded.');
});

test('handleGatewayCommand installs a plugin from a local TUI/web session and reloads plugins', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const result = await handleGatewayCommand({
    sessionId: 'session-plugin-install',
    guildId: null,
    channelId: 'tui',
    args: ['plugin', 'install', './plugins/qmd-memory'],
  });

  expect(installPluginMock).toHaveBeenCalledWith('./plugins/qmd-memory');
  expect(reloadPluginManagerMock).toHaveBeenCalled();
  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Plugin Installed');
  expect(result.text).toContain(
    'Installed plugin `demo-plugin` to `/tmp/.hybridclaw/plugins/demo-plugin`.',
  );
  expect(result.text).toContain('Installed plugin npm dependencies.');
  expect(result.text).toContain('Required env vars: DEMO_PLUGIN_TOKEN');
  expect(result.text).toContain('required config keys: workspaceId');
  expect(result.text).toContain('Plugin runtime reloaded.');
});

test('handleGatewayCommand rejects plugin install outside local TUI/web sessions', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const result = await handleGatewayCommand({
    sessionId: 'session-plugin-install-remote',
    guildId: 'guild-1',
    channelId: 'discord-channel-1',
    args: ['plugin', 'install', './plugins/qmd-memory'],
  });

  expect(installPluginMock).not.toHaveBeenCalled();
  expect(result.kind).toBe('error');
  if (result.kind !== 'error') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Plugin Install Restricted');
  expect(result.text).toContain('only available from local TUI/web sessions');
});

test('handleGatewayCommand reports plugin install failures', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  installPluginMock.mockRejectedValueOnce(new Error('plugin path not found'));

  const result = await handleGatewayCommand({
    sessionId: 'session-plugin-install-failed',
    guildId: null,
    channelId: 'web',
    args: ['plugin', 'install', './plugins/missing-plugin'],
  });

  expect(result.kind).toBe('error');
  if (result.kind !== 'error') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Plugin Install Failed');
  expect(result.text).toBe('plugin path not found');
});

test('handleGatewayCommand reinstalls a plugin from a local TUI/web session and reloads plugins', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const result = await handleGatewayCommand({
    sessionId: 'session-plugin-reinstall',
    guildId: null,
    channelId: 'tui',
    args: ['plugin', 'reinstall', './plugins/qmd-memory'],
  });

  expect(reinstallPluginMock).toHaveBeenCalledWith('./plugins/qmd-memory');
  expect(reloadPluginManagerMock).toHaveBeenCalled();
  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Plugin Reinstalled');
  expect(result.text).toContain(
    'Reinstalled plugin `demo-plugin` to `/tmp/.hybridclaw/plugins/demo-plugin`.',
  );
  expect(result.text).toContain('Installed plugin npm dependencies.');
  expect(result.text).toContain('Plugin runtime reloaded.');
});

test('handleGatewayCommand dispatches plugin-registered commands', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  const handler = vi.fn(async () => 'QMD index is ready.');
  pluginManagerMock.findCommand.mockReturnValue({
    name: 'qmd',
    description: 'Show QMD status',
    handler,
  });

  const result = await handleGatewayCommand({
    sessionId: 'session-plugin-command',
    guildId: 'guild-123',
    channelId: 'web',
    userId: 'user-42',
    username: 'alice',
    args: ['qmd', 'status'],
  });

  expect(pluginManagerMock.findCommand).toHaveBeenCalledWith('qmd');
  expect(handler).toHaveBeenCalledWith(['status'], {
    sessionId: 'session-plugin-command',
    channelId: 'web',
    userId: 'user-42',
    username: 'alice',
    guildId: 'guild-123',
  });
  expect(result.kind).toBe('plain');
  expect(result.text).toBe('QMD index is ready.');
});

test('handleGatewayCommand stringifies non-string plugin command results', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  const handler = vi.fn(async () => ({
    ok: true,
    message: 'structured payload',
  }));
  pluginManagerMock.findCommand.mockReturnValue({
    name: 'qmd',
    description: 'Show QMD status',
    handler,
  });

  const result = await handleGatewayCommand({
    sessionId: 'session-plugin-command-object',
    guildId: null,
    channelId: 'web',
    userId: 'user-42',
    username: 'alice',
    args: ['qmd', 'status'],
  });

  expect(result.kind).toBe('plain');
  expect(result.text).toBe(
    JSON.stringify(
      {
        ok: true,
        message: 'structured payload',
      },
      null,
      2,
    ),
  );
});

test('handleGatewayCommand help continues without plugins when plugin manager init fails', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  ensurePluginManagerInitializedMock.mockRejectedValueOnce(
    new Error('plugin init failed'),
  );

  const result = await handleGatewayCommand({
    sessionId: 'session-plugin-help',
    guildId: null,
    channelId: 'web',
    args: ['help'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('HybridClaw Commands');
  expect(result.text).toContain(
    '`plugin config <plugin-id> [key] [value|--unset]`',
  );
  expect(result.text).toContain('`plugin install <path|npm-spec>`');
  expect(result.text).toContain('`plugin reinstall <path|npm-spec>`');
  expect(result.text).toContain('`plugin reload`');
});

test('handleGatewayCommand uninstalls a plugin and reloads the plugin manager', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const result = await handleGatewayCommand({
    sessionId: 'session-plugin-uninstall',
    guildId: null,
    channelId: 'web',
    args: ['plugin', 'uninstall', 'demo-plugin'],
  });

  expect(uninstallPluginMock).toHaveBeenCalledWith('demo-plugin');
  expect(shutdownPluginManagerMock).toHaveBeenCalled();
  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Plugin Uninstalled');
  expect(result.text).toContain(
    'Uninstalled plugin `demo-plugin` from `/tmp/.hybridclaw/plugins/demo-plugin`.',
  );
  expect(result.text).toContain(
    'Removed 1 matching `plugins.list[]` override.',
  );
  expect(result.text).toContain('Plugin runtime will reload on the next turn.');
});

test('handleGatewayCommand reloads plugins without inlining the plugin list', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  pluginManagerMock.listPluginSummary.mockReturnValueOnce([
    {
      id: 'demo-plugin',
      name: 'Demo Plugin',
      version: '1.0.0',
      description: 'Demo plugin for testing',
      source: 'home',
      enabled: true,
      error: undefined,
      commands: ['demo_status'],
      tools: ['demo_tool'],
      hooks: [],
    },
  ]);

  const result = await handleGatewayCommand({
    sessionId: 'session-plugin-reload',
    guildId: null,
    channelId: 'web',
    args: ['plugin', 'reload'],
  });

  expect(reloadPluginManagerMock).toHaveBeenCalled();
  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Plugins Reloaded');
  expect(result.text).toBe('Plugin runtime reloaded.');
  expect(result.text).not.toContain('demo-plugin');
});

test('getGatewayAdminPlugins summarizes plugin status for the admin console', async () => {
  setupHome();

  const { getGatewayAdminPlugins } = await import(
    '../src/gateway/gateway-service.ts'
  );

  pluginManagerMock.listPluginSummary.mockReset();
  pluginManagerMock.listPluginSummary.mockReturnValue([
    {
      id: 'demo-plugin',
      name: 'Demo Plugin',
      version: '1.0.0',
      description: 'Demo plugin for testing',
      source: 'home',
      enabled: true,
      error: undefined,
      commands: ['demo_status'],
      tools: ['demo_tool'],
      hooks: ['gateway_start'],
    },
    {
      id: 'broken-plugin',
      name: 'Broken Plugin',
      version: undefined,
      description: undefined,
      source: 'project',
      enabled: false,
      error: 'Missing required env vars: DEMO_PLUGIN_TOKEN.',
      commands: [],
      tools: ['broken_tool'],
      hooks: [],
    },
  ]);

  const result = await getGatewayAdminPlugins();

  expect(ensurePluginManagerInitializedMock).toHaveBeenCalled();
  expect(result).toEqual({
    totals: {
      totalPlugins: 2,
      enabledPlugins: 1,
      failedPlugins: 1,
      commands: 1,
      tools: 2,
      hooks: 1,
    },
    plugins: [
      {
        id: 'broken-plugin',
        name: 'Broken Plugin',
        version: null,
        description: null,
        source: 'project',
        enabled: false,
        status: 'failed',
        error: 'Missing required env vars: DEMO_PLUGIN_TOKEN.',
        commands: [],
        tools: ['broken_tool'],
        hooks: [],
      },
      {
        id: 'demo-plugin',
        name: 'Demo Plugin',
        version: '1.0.0',
        description: 'Demo plugin for testing',
        source: 'home',
        enabled: true,
        status: 'loaded',
        error: null,
        commands: ['demo_status'],
        tools: ['demo_tool'],
        hooks: ['gateway_start'],
      },
    ],
  });
});
