import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir();
const ORIGINAL_DATA_DIR = process.env.HYBRIDCLAW_DATA_DIR;
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DISABLE_CONFIG_WATCHER =
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;

let homeDir: string;

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function writeIMessageConfig(options: {
  enabled: boolean;
  serverUrl: string;
}): Promise<void> {
  const runtimeConfig = await import('../src/config/runtime-config.js');
  const configPath = runtimeConfig.runtimeConfigPath();
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<
    string,
    unknown
  >;
  config.imessage = {
    ...(config.imessage as Record<string, unknown>),
    enabled: options.enabled,
    backend: 'bluebubbles',
    serverUrl: options.serverUrl,
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

beforeEach(() => {
  homeDir = makeTempDir();
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DATA_DIR = path.join(homeDir, '.hybridclaw', 'data');
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
  restoreEnvVar('HOME', ORIGINAL_HOME);
  restoreEnvVar('HYBRIDCLAW_DATA_DIR', ORIGINAL_DATA_DIR);
  restoreEnvVar(
    'HYBRIDCLAW_DISABLE_CONFIG_WATCHER',
    ORIGINAL_DISABLE_CONFIG_WATCHER,
  );
});

describe('iMessage runtime config checks', () => {
  test.each([
    '',
    'https://bluebubbles.example.com',
    'https://bluebubbles.example.com/',
  ])(
    'rejects an enabled BlueBubbles backend without a real server URL (%s)',
    async (serverUrl) => {
      await writeIMessageConfig({ enabled: true, serverUrl });
      const { checkConfigFile } = await import(
        '../src/doctor/checks/config.js'
      );

      const results = await checkConfigFile();

      expect(results).toHaveLength(1);
      expect(results[0]?.severity).toBe('error');
      expect(results[0]?.message).toContain('imessage.serverUrl');
    },
  );

  test('accepts an enabled BlueBubbles backend with a server URL', async () => {
    await writeIMessageConfig({
      enabled: true,
      serverUrl: 'https://bluebubbles.test',
    });
    const { checkConfigFile } = await import(
      '../src/doctor/checks/config.js'
    );

    const results = await checkConfigFile();

    expect(results).toEqual([
      expect.objectContaining({
        label: 'Config',
        severity: 'ok',
      }),
    ]);
  });

  test('allows a disabled BlueBubbles backend without a server URL', async () => {
    await writeIMessageConfig({ enabled: false, serverUrl: '' });
    const { checkConfigFile } = await import(
      '../src/doctor/checks/config.js'
    );

    const results = await checkConfigFile();

    expect(results[0]?.severity).toBe('ok');
  });
});
