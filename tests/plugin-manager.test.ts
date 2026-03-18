import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';
import type { RuntimeConfig } from '../src/config/runtime-config.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function loadRuntimeConfig(): RuntimeConfig {
  return JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'config.example.json'), 'utf-8'),
  ) as RuntimeConfig;
}

function writeDemoPlugin(
  rootDir: string,
  options?: {
    requireWorkspaceId?: boolean;
    workspaceDefault?: string;
  },
): void {
  const pluginDir = path.join(rootDir, '.hybridclaw', 'plugins', 'demo-plugin');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'hybridclaw.plugin.yaml'),
    [
      'id: demo-plugin',
      'name: Demo Plugin',
      'kind: tool',
      'configSchema:',
      '  type: object',
      '  properties:',
      '    workspaceId:',
      '      type: string',
      ...(options?.workspaceDefault
        ? [`      default: ${options.workspaceDefault}`]
        : []),
      '    autoRecall:',
      '      type: boolean',
      '      default: true',
      ...(options?.requireWorkspaceId === false
        ? []
        : ['  required: [workspaceId]']),
      '',
    ].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(pluginDir, 'index.ts'),
    [
      'export default {',
      "  id: 'demo-plugin',",
      '  register(api) {',
      '    const cfg = api.pluginConfig;',
      '    api.registerMemoryLayer({',
      "      id: 'demo-memory',",
      '      priority: 50,',
      '      async getContextForPrompt() {',
      '        return "workspace=" + String(cfg.workspaceId) + " autoRecall=" + String(cfg.autoRecall);',
      '      },',
      '    });',
      '    api.registerPromptHook({',
      "      id: 'demo-hook',",
      '      render() {',
      "        return 'hook-context';",
      '      },',
      '    });',
      '    api.registerTool({',
      "      name: 'demo_echo',",
      "      description: 'Echo a plugin value',",
      '      parameters: {',
      "        type: 'object',",
      "        properties: { text: { type: 'string' } },",
      "        required: ['text'],",
      '      },',
      '      handler(args) {',
      '        return String(cfg.workspaceId) + ":" + String(cfg.autoRecall) + ":" + String(args.text || "");',
      '      },',
      '    });',
      '  },',
      '};',
      '',
    ].join('\n'),
    'utf-8',
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('plugin manager auto-discovers plugins from project directories without config entries', async () => {
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  writeDemoPlugin(cwd, {
    requireWorkspaceId: false,
    workspaceDefault: 'workspace-auto',
  });

  const config = loadRuntimeConfig();
  config.plugins.list = [];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });

  await manager.ensureInitialized();

  expect(manager.getToolDefinitions()).toEqual([
    expect.objectContaining({ name: 'demo_echo' }),
  ]);
  await expect(
    manager.executeTool({
      toolName: 'demo_echo',
      args: { text: 'hello' },
      sessionId: 'session-1',
      channelId: 'web',
    }),
  ).resolves.toBe('workspace-auto:true:hello');
});

test('plugin manager loads configured plugins, applies config defaults, and exposes tools', async () => {
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  writeDemoPlugin(cwd);

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'demo-plugin',
      enabled: true,
      config: {
        workspaceId: 'workspace-123',
      },
    },
  ];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });

  await manager.ensureInitialized();

  expect(manager.getToolDefinitions()).toEqual([
    expect.objectContaining({ name: 'demo_echo' }),
  ]);
  expect(
    await manager.collectPromptContext({
      sessionId: 'session-1',
      userId: 'user-1',
      agentId: 'main',
      channelId: 'web',
      recentMessages: [],
    }),
  ).toEqual(['workspace=workspace-123 autoRecall=true', 'hook-context']);
  await expect(
    manager.executeTool({
      toolName: 'demo_echo',
      args: { text: 'hello' },
      sessionId: 'session-1',
      channelId: 'web',
    }),
  ).resolves.toBe('workspace-123:true:hello');
  expect(manager.listPluginSummary()).toEqual([
    {
      id: 'demo-plugin',
      name: 'Demo Plugin',
      version: undefined,
      source: 'project',
      enabled: true,
      error: undefined,
      tools: ['demo_echo'],
      hooks: ['demo-hook'],
    },
  ]);
});

test('plugin manager honors config overrides that disable an auto-discovered plugin', async () => {
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  writeDemoPlugin(cwd, {
    requireWorkspaceId: false,
    workspaceDefault: 'workspace-auto',
  });

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'demo-plugin',
      enabled: false,
      config: {},
    },
  ];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });

  await manager.ensureInitialized();

  expect(manager.getToolDefinitions()).toEqual([]);
  expect(
    await manager.collectPromptContext({
      sessionId: 'session-1',
      userId: 'user-1',
      agentId: 'main',
      channelId: 'web',
      recentMessages: [],
    }),
  ).toEqual([]);
});

test('plugin manager disables plugins with missing required env vars before import', async () => {
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  const pluginDir = path.join(
    cwd,
    '.hybridclaw',
    'plugins',
    'env-plugin',
  );
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'hybridclaw.plugin.yaml'),
    [
      'id: env-plugin',
      'name: Env Plugin',
      'kind: tool',
      'requires:',
      '  env: [HYBRIDCLAW_PLUGIN_MISSING_ENV_TEST]',
      '',
    ].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(pluginDir, 'index.ts'),
    [
      "throw new Error('should not import');",
      'export default {',
      "  id: 'env-plugin',",
      '  register() {},',
      '};',
      '',
    ].join('\n'),
    'utf-8',
  );

  const originalEnv = process.env.HYBRIDCLAW_PLUGIN_MISSING_ENV_TEST;
  delete process.env.HYBRIDCLAW_PLUGIN_MISSING_ENV_TEST;

  const config = loadRuntimeConfig();
  config.plugins.list = [];

  try {
    const { PluginManager } = await import('../src/plugins/plugin-manager.js');
    const manager = new PluginManager({
      homeDir,
      cwd,
      getRuntimeConfig: () => config,
    });

    await expect(manager.ensureInitialized()).resolves.toBeUndefined();

    expect(manager.getToolDefinitions()).toEqual([]);
    expect(manager.getLoadedPlugins()).toEqual([
      expect.objectContaining({
        id: 'env-plugin',
        enabled: false,
        status: 'failed',
        error:
          'Missing required env vars: HYBRIDCLAW_PLUGIN_MISSING_ENV_TEST.',
        toolsRegistered: [],
        hooksRegistered: [],
      }),
    ]);
    expect(manager.listPluginSummary()).toEqual([
      {
        id: 'env-plugin',
        name: 'Env Plugin',
        version: undefined,
        source: 'project',
        enabled: false,
        error:
          'Missing required env vars: HYBRIDCLAW_PLUGIN_MISSING_ENV_TEST.',
        tools: [],
        hooks: [],
      },
    ]);
  } finally {
    if (originalEnv === undefined) {
      delete process.env.HYBRIDCLAW_PLUGIN_MISSING_ENV_TEST;
    } else {
      process.env.HYBRIDCLAW_PLUGIN_MISSING_ENV_TEST = originalEnv;
    }
  }
});

test('plugin manager rejects invalid plugin config against configSchema', async () => {
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  writeDemoPlugin(cwd);

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'demo-plugin',
      enabled: true,
      config: {},
    },
  ];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });

  await expect(manager.ensureInitialized()).resolves.toBeUndefined();
  expect(manager.getToolDefinitions()).toEqual([]);
  expect(manager.getLoadedPlugins()).toEqual([
    expect.objectContaining({
      id: 'demo-plugin',
      enabled: true,
      status: 'failed',
      error: 'plugin config.workspaceId is required.',
      toolsRegistered: [],
      hooksRegistered: [],
    }),
  ]);
});

test('plugin manager isolates module load failures and continues loading healthy plugins', async () => {
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  writeDemoPlugin(cwd, {
    requireWorkspaceId: false,
    workspaceDefault: 'workspace-auto',
  });

  const brokenDir = path.join(
    cwd,
    '.hybridclaw',
    'plugins',
    'broken-plugin',
  );
  fs.mkdirSync(brokenDir, { recursive: true });
  fs.writeFileSync(
    path.join(brokenDir, 'hybridclaw.plugin.yaml'),
    ['id: broken-plugin', 'name: Broken Plugin', 'kind: tool', ''].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(brokenDir, 'index.ts'),
    ['export default {', "  id: 'broken-plugin',", '  register(', ''].join(
      '\n',
    ),
    'utf-8',
  );

  const config = loadRuntimeConfig();
  config.plugins.list = [];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });

  await expect(manager.ensureInitialized()).resolves.toBeUndefined();

  expect(manager.getToolDefinitions()).toEqual([
    expect.objectContaining({ name: 'demo_echo' }),
  ]);
  expect(manager.getLoadedPlugins()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'demo-plugin',
        enabled: true,
        status: 'loaded',
        toolsRegistered: ['demo_echo'],
        hooksRegistered: ['demo-hook'],
      }),
      expect.objectContaining({
        id: 'broken-plugin',
        enabled: true,
        status: 'failed',
        error: expect.any(String),
        toolsRegistered: [],
        hooksRegistered: [],
      }),
    ]),
  );
  expect(manager.listPluginSummary()).toEqual(
    expect.arrayContaining([
      {
        id: 'demo-plugin',
        name: 'Demo Plugin',
        version: undefined,
        source: 'project',
        enabled: true,
        error: undefined,
        tools: ['demo_echo'],
        hooks: ['demo-hook'],
      },
      expect.objectContaining({
        id: 'broken-plugin',
        name: 'Broken Plugin',
        source: 'project',
        enabled: true,
        tools: [],
        hooks: [],
        error: expect.any(String),
      }),
    ]),
  );
});

test('plugin manager rolls back partial registration when register throws', async () => {
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  const pluginDir = path.join(
    cwd,
    '.hybridclaw',
    'plugins',
    'broken-plugin',
  );
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'hybridclaw.plugin.yaml'),
    [
      'id: broken-plugin',
      'name: Broken Plugin',
      'kind: tool',
      'configSchema:',
      '  type: object',
      '',
    ].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(pluginDir, 'index.ts'),
    [
      'export default {',
      "  id: 'broken-plugin',",
      '  register(api) {',
      '    api.registerTool({',
      "      name: 'broken_echo',",
      "      description: 'Broken echo',",
      '      parameters: {',
      "        type: 'object',",
      '        properties: {},',
      '        required: [],',
      '      },',
      "      handler() { return 'broken'; },",
      '    });',
      "    throw new Error('register exploded');",
      '  },',
      '};',
      '',
    ].join('\n'),
    'utf-8',
  );

  const config = loadRuntimeConfig();
  config.plugins.list = [];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });

  await expect(manager.ensureInitialized()).resolves.toBeUndefined();

  expect(manager.getToolDefinitions()).toEqual([]);
  expect(manager.getLoadedPlugins()).toEqual([
    expect.objectContaining({
      id: 'broken-plugin',
      enabled: true,
      status: 'failed',
      error: 'register exploded',
      toolsRegistered: ['broken_echo'],
      hooksRegistered: [],
    }),
  ]);
});
