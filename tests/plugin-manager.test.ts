import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';
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

function writePassivePlugin(rootDir: string, pluginId: string): void {
  const pluginDir = path.join(rootDir, '.hybridclaw', 'plugins', pluginId);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'hybridclaw.plugin.yaml'),
    [`id: ${pluginId}`, `name: ${pluginId}`, 'kind: tool', ''].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(pluginDir, 'index.ts'),
    [
      'export default {',
      `  id: '${pluginId}',`,
      '  register() {},',
      '};',
      '',
    ].join('\n'),
    'utf-8',
  );
}

function compiledPluginModulePath(rootDir: string, pluginId: string): string {
  return path.join(
    rootDir,
    '.hybridclaw',
    'plugins',
    pluginId,
    '.index.hybridclaw.mjs',
  );
}

function writeNodeRequirementPlugin(
  rootDir: string,
  options: {
    pluginId: string;
    nodeRequirement: string;
    throwOnImport?: boolean;
  },
): void {
  const pluginDir = path.join(
    rootDir,
    '.hybridclaw',
    'plugins',
    options.pluginId,
  );
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'hybridclaw.plugin.yaml'),
    [
      `id: ${options.pluginId}`,
      `name: ${options.pluginId}`,
      'kind: tool',
      'requires:',
      `  node: "${options.nodeRequirement}"`,
      '',
    ].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(pluginDir, 'index.ts'),
    [
      ...(options.throwOnImport
        ? ["throw new Error('should not import');"]
        : []),
      'export default {',
      `  id: '${options.pluginId}',`,
      '  register(api) {',
      '    api.registerTool({',
      `      name: '${options.pluginId}_echo',`,
      `      description: 'Echo from ${options.pluginId}',`,
      '      parameters: {',
      "        type: 'object',",
      '        properties: {},',
      '        required: [],',
      '      },',
      "      handler() { return 'ok'; },",
      '    });',
      '  },',
      '};',
      '',
    ].join('\n'),
    'utf-8',
  );
}

function writeThrowingImportPlugin(rootDir: string, pluginId: string): void {
  const pluginDir = path.join(rootDir, '.hybridclaw', 'plugins', pluginId);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'hybridclaw.plugin.yaml'),
    [`id: ${pluginId}`, `name: ${pluginId}`, 'kind: tool', ''].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(pluginDir, 'index.ts'),
    ["throw new Error('import exploded');", ''].join('\n'),
    'utf-8',
  );
}

function writeLifecycleGetterPlugin(rootDir: string): void {
  const pluginDir = path.join(
    rootDir,
    '.hybridclaw',
    'plugins',
    'lifecycle-plugin',
  );
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'hybridclaw.plugin.yaml'),
    ['id: lifecycle-plugin', 'name: Lifecycle Plugin', 'kind: tool', ''].join(
      '\n',
    ),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(pluginDir, 'index.ts'),
    [
      'export default {',
      "  id: 'lifecycle-plugin',",
      '  register(api) {',
      '    api.registerMemoryLayer({',
      "      id: 'getter-memory',",
      '      priority: 10,',
      '      get start() {',
      "        throw new Error('memory start getter exploded');",
      '      },',
      '    });',
      '    api.registerService({',
      "      id: 'getter-service',",
      '      get start() {',
      "        throw new Error('service start getter exploded');",
      '      },',
      '    });',
      '    api.registerTool({',
      "      name: 'lifecycle_echo',",
      "      description: 'Echo from a lifecycle test plugin',",
      '      parameters: {',
      "        type: 'object',",
      '        properties: {},',
      '        required: [],',
      '      },',
      "      handler() { return 'ok'; },",
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

test('loadPluginManifest trims optional strings and normalizes nested sections', async () => {
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  const manifestPath = path.join(cwd, 'hybridclaw.plugin.yaml');
  fs.writeFileSync(
    manifestPath,
    [
      'id: " demo-plugin "',
      'name: " Demo Plugin "',
      'version: " 1.2.3 "',
      'description: " Example plugin "',
      'kind: tool',
      'author: " Example Author "',
      'entrypoint: " dist/index.js "',
      'requires:',
      '  env: [" API_KEY ", "", 42, " SECOND_KEY "]',
      '  node: " >=22 "',
      'install:',
      '  - kind: download',
      '    url: " https://example.com/plugin.tgz "',
      '  - kind: invalid',
      '    package: " @scope/plugin-extra "',
      'configUiHints:',
      '  workspaceId:',
      '    label: " Workspace "',
      '    placeholder: " Enter workspace "',
      '    help: " Used for recall "',
      '  ignored: 123',
      '',
    ].join('\n'),
    'utf-8',
  );

  const { loadPluginManifest } = await import(
    '../src/plugins/plugin-manager.js'
  );

  expect(loadPluginManifest(manifestPath)).toEqual({
    id: 'demo-plugin',
    name: 'Demo Plugin',
    version: '1.2.3',
    description: 'Example plugin',
    kind: 'tool',
    author: 'Example Author',
    entrypoint: 'dist/index.js',
    requires: {
      env: ['API_KEY', 'SECOND_KEY'],
      node: '>=22',
    },
    install: [
      {
        kind: 'download',
        package: undefined,
        url: 'https://example.com/plugin.tgz',
      },
      {
        kind: 'npm',
        package: '@scope/plugin-extra',
        url: undefined,
      },
    ],
    configSchema: undefined,
    configUiHints: {
      workspaceId: {
        label: 'Workspace',
        placeholder: 'Enter workspace',
        help: 'Used for recall',
      },
    },
  });
});

test('loadPluginManifest rejects blank manifest ids', async () => {
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  const manifestPath = path.join(cwd, 'hybridclaw.plugin.yaml');
  fs.writeFileSync(manifestPath, 'id: "   "\n', 'utf-8');

  const { loadPluginManifest } = await import(
    '../src/plugins/plugin-manager.js'
  );

  expect(() => loadPluginManifest(manifestPath)).toThrow(
    'Plugin manifest is missing `id`.',
  );
});

test('validatePluginConfig enforces common JSON Schema keywords via Ajv', async () => {
  const { validatePluginConfig } = await import(
    '../src/plugins/plugin-manager.js'
  );

  const schema = {
    type: 'object',
    properties: {
      workspaceId: {
        type: 'string',
        minLength: 4,
        pattern: '^ws-',
      },
      recallLimit: {
        type: 'integer',
        minimum: 1,
        maximum: 5,
      },
    },
    required: ['workspaceId', 'recallLimit'],
    additionalProperties: false,
  } as const;

  expect(() =>
    validatePluginConfig(schema, {
      workspaceId: 'ws',
      recallLimit: 2,
    }),
  ).toThrow('plugin config.workspaceId must NOT have fewer than 4 characters.');

  expect(() =>
    validatePluginConfig(schema, {
      workspaceId: 'bad-value',
      recallLimit: 2,
    }),
  ).toThrow('plugin config.workspaceId must match pattern "^ws-".');

  expect(() =>
    validatePluginConfig(schema, {
      workspaceId: 'ws-good',
      recallLimit: 9,
    }),
  ).toThrow('plugin config.recallLimit must be <= 5.');
});

test('validatePluginConfig applies defaults and strips additional properties', async () => {
  const { validatePluginConfig } = await import(
    '../src/plugins/plugin-manager.js'
  );

  expect(
    validatePluginConfig(
      {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            default: 'ws-default',
          },
          autoRecall: {
            type: 'boolean',
            default: true,
          },
        },
        additionalProperties: false,
      },
      {
        extra: 'drop-me',
      },
    ),
  ).toEqual({
    workspaceId: 'ws-default',
    autoRecall: true,
  });
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
  expect(fs.existsSync(compiledPluginModulePath(cwd, 'demo-plugin'))).toBe(
    false,
  );
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
  const pluginDir = path.join(cwd, '.hybridclaw', 'plugins', 'env-plugin');
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
        error: 'Missing required env vars: HYBRIDCLAW_PLUGIN_MISSING_ENV_TEST.',
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
        error: 'Missing required env vars: HYBRIDCLAW_PLUGIN_MISSING_ENV_TEST.',
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

test('plugin manager treats bare node requirements as version pins instead of minimums', async () => {
  const currentMajor = Number.parseInt(
    process.versions.node.split('.')[0] || '0',
    10,
  );
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  writeNodeRequirementPlugin(cwd, {
    pluginId: 'same-major-plugin',
    nodeRequirement: String(currentMajor),
  });
  writeNodeRequirementPlugin(cwd, {
    pluginId: 'older-major-plugin',
    nodeRequirement: String(Math.max(currentMajor - 1, 0)),
    throwOnImport: true,
  });

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
    expect.objectContaining({ name: 'same-major-plugin_echo' }),
  ]);
  expect(manager.getLoadedPlugins()).toEqual([
    expect.objectContaining({
      id: 'same-major-plugin',
      enabled: true,
      status: 'loaded',
      toolsRegistered: ['same-major-plugin_echo'],
      hooksRegistered: [],
    }),
  ]);
  expect(
    fs.existsSync(compiledPluginModulePath(cwd, 'same-major-plugin')),
  ).toBe(false);
});

test('plugin manager isolates module load failures and continues loading healthy plugins', async () => {
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  writeDemoPlugin(cwd, {
    requireWorkspaceId: false,
    workspaceDefault: 'workspace-auto',
  });

  const brokenDir = path.join(cwd, '.hybridclaw', 'plugins', 'broken-plugin');
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
  expect(fs.existsSync(compiledPluginModulePath(cwd, 'demo-plugin'))).toBe(
    false,
  );
});

test('plugin manager isolates unexpected loadPlugin crashes and continues loading healthy plugins', async () => {
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  writeDemoPlugin(cwd, {
    requireWorkspaceId: false,
    workspaceDefault: 'workspace-auto',
  });
  writePassivePlugin(cwd, 'unexpected-plugin');

  const config = loadRuntimeConfig();
  config.plugins.list = [];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });
  const originalLoadPlugin = manager.loadPlugin.bind(manager);
  vi.spyOn(manager, 'loadPlugin').mockImplementation(
    async (candidate, runtimeConfig, registrationMode) => {
      if (candidate.id === 'unexpected-plugin') {
        throw new Error('unexpected load crash');
      }
      return originalLoadPlugin(candidate, runtimeConfig, registrationMode);
    },
  );

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
        id: 'unexpected-plugin',
        enabled: true,
        status: 'failed',
        error: 'unexpected load crash',
        toolsRegistered: [],
        hooksRegistered: [],
      }),
    ]),
  );
});

test('plugin manager survives throwing lifecycle start getters and keeps plugin tools available', async () => {
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  writeLifecycleGetterPlugin(cwd);

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
    expect.objectContaining({ name: 'lifecycle_echo' }),
  ]);
  expect(manager.getLoadedPlugins()).toEqual([
    expect.objectContaining({
      id: 'lifecycle-plugin',
      enabled: true,
      status: 'loaded',
      toolsRegistered: ['lifecycle_echo'],
      hooksRegistered: [],
    }),
  ]);
});

test('plugin manager removes temporary compiled modules after TypeScript import failures', async () => {
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  writeDemoPlugin(cwd, {
    requireWorkspaceId: false,
    workspaceDefault: 'workspace-auto',
  });
  writeThrowingImportPlugin(cwd, 'throwing-plugin');

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
        id: 'throwing-plugin',
        enabled: true,
        status: 'failed',
        error: 'import exploded',
      }),
    ]),
  );
  expect(fs.existsSync(compiledPluginModulePath(cwd, 'demo-plugin'))).toBe(
    false,
  );
  expect(fs.existsSync(compiledPluginModulePath(cwd, 'throwing-plugin'))).toBe(
    false,
  );
});

test('plugin manager survives unexpected gateway_start phase crashes', async () => {
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
  vi.spyOn(manager as any, 'dispatchHook').mockImplementation(
    async (name: string) => {
      if (name === 'gateway_start') {
        throw new Error('gateway start exploded');
      }
    },
  );

  await expect(manager.ensureInitialized()).resolves.toBeUndefined();

  expect(manager.getToolDefinitions()).toEqual([
    expect.objectContaining({ name: 'demo_echo' }),
  ]);
});

test('plugin manager rolls back partial registration when register throws', async () => {
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  const pluginDir = path.join(cwd, '.hybridclaw', 'plugins', 'broken-plugin');
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
