import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeConfig } from '../src/config/runtime-config.ts';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DISABLE_CONFIG_WATCHER =
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-config-models-'));
}

function writeRuntimeConfig(
  homeDir: string,
  mutator?: (config: RuntimeConfig) => void,
): void {
  const configPath = path.join(homeDir, '.hybridclaw', 'config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const config = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'config.example.json'), 'utf-8'),
  ) as RuntimeConfig;
  config.ops.dbPath = path.join(
    homeDir,
    '.hybridclaw',
    'data',
    'hybridclaw.db',
  );
  mutator?.(config);
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

async function importFreshConfig(homeDir: string) {
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  vi.resetModules();
  return import('../src/config/config.ts');
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

describe('configured model catalog', () => {
  it('builds a deduplicated shared model list from hybridai, codex, and openrouter config', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir, (config) => {
      config.hybridai.models = ['gpt-5-nano', 'shared-model', 'gpt-5'];
      config.codex.models = ['shared-model', 'openai-codex/gpt-5.4'];
      config.openrouter.enabled = true;
      config.openrouter.models = [
        'shared-model',
        'openrouter/anthropic/claude-sonnet-4',
      ];
    });

    const config = await importFreshConfig(homeDir);

    expect(config.HYBRIDAI_MODELS).toEqual([
      'gpt-5-nano',
      'shared-model',
      'gpt-5',
    ]);
    expect(config.CODEX_MODELS).toEqual([
      'shared-model',
      'openai-codex/gpt-5.4',
    ]);
    expect(config.OPENROUTER_ENABLED).toBe(true);
    expect(config.OPENROUTER_MODELS).toEqual([
      'shared-model',
      'openrouter/anthropic/claude-sonnet-4',
    ]);
    expect(config.CONFIGURED_MODELS).toEqual([
      'gpt-5-nano',
      'shared-model',
      'gpt-5',
      'openai-codex/gpt-5.4',
      'openrouter/anthropic/claude-sonnet-4',
    ]);
  });
});
