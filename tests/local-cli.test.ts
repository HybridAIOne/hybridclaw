import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import type { RuntimeConfig } from '../src/config/runtime-config.js';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DISABLE_CONFIG_WATCHER =
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-local-cli-'));
}

async function importFreshCli(homeDir: string) {
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  vi.resetModules();
  return import('../src/cli.ts');
}

function readRuntimeConfig(homeDir: string): RuntimeConfig {
  return JSON.parse(
    fs.readFileSync(path.join(homeDir, '.hybridclaw', 'config.json'), 'utf-8'),
  ) as RuntimeConfig;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  if (ORIGINAL_DISABLE_CONFIG_WATCHER === undefined) {
    delete process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
  } else {
    process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER =
      ORIGINAL_DISABLE_CONFIG_WATCHER;
  }
});

test('local configure lmstudio enables the backend and normalizes the URL', async () => {
  const homeDir = makeTempHome();
  const cli = await importFreshCli(homeDir);
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  await cli.main([
    'local',
    'configure',
    'lmstudio',
    'qwen/qwen3.5-9b',
    '--base-url',
    'http://127.0.0.1:1234',
  ]);

  const config = readRuntimeConfig(homeDir);
  expect(config.local.backends.lmstudio.enabled).toBe(true);
  expect(config.local.backends.lmstudio.baseUrl).toBe(
    'http://127.0.0.1:1234/v1',
  );
  expect(config.hybridai.defaultModel).toBe('lmstudio/qwen/qwen3.5-9b');
  expect(logSpy).toHaveBeenCalledWith(
    expect.stringContaining('Updated runtime config at'),
  );
});

test('local configure --no-default preserves the existing default model', async () => {
  const homeDir = makeTempHome();
  const cli = await importFreshCli(homeDir);

  await cli.main([
    'local',
    'configure',
    'lmstudio',
    'qwen/qwen3.5-9b',
    '--base-url',
    'http://127.0.0.1:1234',
    '--no-default',
  ]);

  const config = readRuntimeConfig(homeDir);
  expect(config.local.backends.lmstudio.enabled).toBe(true);
  expect(config.hybridai.defaultModel).toBe('gpt-5-nano');
});

test('help local prints local command usage', async () => {
  const homeDir = makeTempHome();
  const cli = await importFreshCli(homeDir);
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  await cli.main(['help', 'local']);

  expect(logSpy).toHaveBeenCalledWith(
    expect.stringContaining('Usage: hybridclaw local <command>'),
  );
});
