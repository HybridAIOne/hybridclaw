import path from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir();
const ORIGINAL_ENV = {
  HOME: process.env.HOME,
  HYBRIDCLAW_DATA_DIR: process.env.HYBRIDCLAW_DATA_DIR,
  HYBRIDCLAW_DISABLE_CONFIG_WATCHER:
    process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER,
};

beforeEach(() => {
  const homeDir = makeTempDir();
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DATA_DIR = path.join(homeDir, '.hybridclaw', 'data');
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

// Adding a caller while the policy answers everyone is a silent no-op, so the
// check that follows every config edit says so.
test('warns when listed callers have no effect under the caller policy', async () => {
  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.js'
  );
  const { checkConfigFile } = await import('../src/doctor/checks/config.js');
  const setVoice = (callerPolicy: 'open' | 'allowlist', allowFrom: string[]) =>
    updateRuntimeConfig((draft) => {
      draft.voice.callerPolicy = callerPolicy;
      draft.voice.allowFrom = allowFrom;
    });

  setVoice('open', ['+4915123456789']);
  expect(await checkConfigFile()).toContainEqual(
    expect.objectContaining({
      label: 'Voice callers',
      severity: 'warn',
      message: expect.stringContaining('every caller is answered'),
    }),
  );

  setVoice('allowlist', ['+4915123456789']);
  expect(await checkConfigFile()).toEqual([
    expect.objectContaining({ label: 'Config', severity: 'ok' }),
  ]);
});
