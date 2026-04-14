import fs from 'node:fs';
import path from 'node:path';

import { expect, test, vi } from 'vitest';
import type { RuntimeConfig } from '../src/config/runtime-config.js';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir();

function loadRuntimeConfig(): RuntimeConfig {
  return JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'config.example.json'), 'utf-8'),
  ) as RuntimeConfig;
}

function writeDemoPlugin(pluginDir: string): void {
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
      '  required: [workspaceId]',
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
      '    api.registerTool({',
      "      name: 'demo_echo',",
      "      description: 'Echo a plugin value',",
      '      parameters: {',
      "        type: 'object',",
      "        properties: { text: { type: 'string' } },",
      "        required: ['text'],",
      '      },',
      '      handler(args) {',
      '        return String(api.pluginConfig.workspaceId) + ":" + String(args.text || "");',
      '      },',
      '    });',
      '  },',
      '};',
      '',
    ].join('\n'),
    'utf-8',
  );
}

useCleanMocks({
  restoreAllMocks: false,
  resetModules: true,
  unmock: ['../src/config/runtime-config.js'],
});

test('ensurePluginManagerInitialized replaces a failed singleton so later calls can recover', async () => {
  const pluginDir = makeTempDir('hybridclaw-plugin-singleton-');
  writeDemoPlugin(pluginDir);

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'demo-plugin',
      enabled: true,
      path: pluginDir,
      config: {
        workspaceId: 'workspace-123',
      },
    },
  ];

  let shouldFail = false;

  vi.doMock('../src/config/runtime-config.js', async () => {
    const actual = await vi.importActual<
      typeof import('../src/config/runtime-config.js')
    >('../src/config/runtime-config.js');
    return {
      ...actual,
      getRuntimeConfig: () => {
        if (shouldFail) {
          throw new Error('runtime config exploded');
        }
        return config;
      },
    };
  });

  const pluginManagerModule = await import('../src/plugins/plugin-manager.js');
  const firstManager = pluginManagerModule.getPluginManager();

  shouldFail = true;

  await expect(
    pluginManagerModule.ensurePluginManagerInitialized(),
  ).rejects.toThrow('runtime config exploded');

  const secondManager = pluginManagerModule.getPluginManager();
  expect(secondManager).not.toBe(firstManager);

  shouldFail = false;

  await expect(
    pluginManagerModule.ensurePluginManagerInitialized(),
  ).resolves.toBe(secondManager);
  expect(secondManager.getToolDefinitions()).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'demo_echo' })]),
  );

  await pluginManagerModule.shutdownPluginManager();
});
