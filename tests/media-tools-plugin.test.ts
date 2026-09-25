import fs from 'node:fs';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

import type { RuntimeConfig } from '../src/config/runtime-config.js';
import { useCleanMocks, useTempDir } from './test-utils.ts';

vi.mock('../src/providers/factory.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/providers/factory.js')>()),
  resolveModelRuntimeCredentials: vi.fn(async () => ({
    provider: 'hybridai',
    model: 'test-model',
    baseUrl: 'https://example.com',
    apiKey: '',
    requestHeaders: {},
  })),
}));

const makeTempDir = useTempDir('hybridclaw-media-tools-plugin-');
useCleanMocks({
  restoreAllMocks: true,
  resetModules: true,
  unstubAllEnvs: true,
});

test('media-tools plugin registers its tools and answers a list action', async () => {
  // Point HOME at a temp dir before runtime-config loads, so the test never
  // reads or migrates the developer's real ~/.hybridclaw/config.json.
  const homeDir = makeTempDir();
  const cwd = makeTempDir();
  vi.stubEnv('HOME', homeDir);
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', path.join(homeDir, '.hybridclaw'));
  vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
  vi.resetModules();

  fs.cpSync(
    path.join(process.cwd(), 'plugins', 'media-tools'),
    path.join(cwd, '.hybridclaw', 'plugins', 'media-tools'),
    { recursive: true },
  );
  const config = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'config.example.json'), 'utf-8'),
  ) as RuntimeConfig;
  config.plugins.list = [{ id: 'media-tools', enabled: true, config: {} }];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });
  await manager.ensureInitialized();

  expect(
    manager
      .getToolDefinitions()
      .map((tool) => tool.name)
      .sort(),
  ).toEqual(['audio_transcribe', 'image_generate', 'video_generate']);

  const output = await manager.executeTool({
    toolName: 'image_generate',
    args: { action: 'list' },
    sessionId: 'session-1',
    channelId: 'web',
  });
  const parsed = JSON.parse(output) as {
    success: boolean;
    providers: Array<{ id: string }>;
  };
  expect(parsed.success).toBe(true);
  expect(parsed.providers.map((provider) => provider.id)).toEqual([
    'openai',
    'gemini',
    'xai',
    'bfl',
  ]);
});
