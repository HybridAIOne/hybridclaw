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

function writeBeforeAgentReplyPlugin(params: {
  rootDir: string;
  pluginId: string;
  priority?: number;
  handlerSource: string[];
}): void {
  const pluginDir = path.join(
    params.rootDir,
    '.hybridclaw',
    'plugins',
    params.pluginId,
  );
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'hybridclaw.plugin.yaml'),
    [
      `id: ${params.pluginId}`,
      `name: ${params.pluginId}`,
      'kind: tool',
      '',
    ].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(pluginDir, 'index.ts'),
    [
      'export default {',
      `  id: '${params.pluginId}',`,
      '  register(api) {',
      "    api.on('before_agent_reply', async (context) => {",
      ...params.handlerSource.map((line) => `      ${line}`),
      `    }, { priority: ${params.priority ?? 0} });`,
      '  },',
      '};',
      '',
    ].join('\n'),
    'utf-8',
  );
}

afterEach(() => {
  vi.resetModules();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('plugin manager returns the first handled before_agent_reply result', async () => {
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  writeBeforeAgentReplyPlugin({
    rootDir: cwd,
    pluginId: 'first-plugin',
    priority: 5,
    handlerSource: [
      `return { handled: true, text: \`first:${'${'}context.prompt}\`, reason: "first" };`,
    ],
  });
  writeBeforeAgentReplyPlugin({
    rootDir: cwd,
    pluginId: 'second-plugin',
    priority: 10,
    handlerSource: [
      `return { handled: true, text: \`second:${'${'}context.prompt}\`, reason: "second" };`,
    ],
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
  await expect(
    manager.runBeforeAgentReply({
      sessionId: 'session-1',
      userId: 'user-1',
      agentId: 'main',
      channelId: 'web',
      prompt: 'hello',
      trigger: 'chat',
      workspacePath: '/tmp/workspace',
      model: 'test-model',
    }),
  ).resolves.toEqual({
    handled: true,
    text: 'first:hello',
    reason: 'first',
    pluginId: 'first-plugin',
  });
});

test('plugin manager continues to later before_agent_reply hooks after failures', async () => {
  const homeDir = makeTempDir('hybridclaw-plugin-home-');
  const cwd = makeTempDir('hybridclaw-plugin-project-');
  writeBeforeAgentReplyPlugin({
    rootDir: cwd,
    pluginId: 'failing-plugin',
    priority: 5,
    handlerSource: ['throw new Error("boom");'],
  });
  writeBeforeAgentReplyPlugin({
    rootDir: cwd,
    pluginId: 'claimer-plugin',
    priority: 10,
    handlerSource: ['return { handled: true, text: "claimed" };'],
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
  await expect(
    manager.runBeforeAgentReply({
      sessionId: 'session-2',
      userId: 'user-2',
      agentId: 'main',
      channelId: 'heartbeat',
      prompt: 'heartbeat poll',
      trigger: 'heartbeat',
      workspacePath: '/tmp/workspace',
      model: 'test-model',
    }),
  ).resolves.toEqual({
    handled: true,
    text: 'claimed',
    pluginId: 'claimer-plugin',
  });
});
