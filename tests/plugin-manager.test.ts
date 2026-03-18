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

  await expect(manager.ensureInitialized()).rejects.toThrow(
    'plugin config.workspaceId is required.',
  );
});
