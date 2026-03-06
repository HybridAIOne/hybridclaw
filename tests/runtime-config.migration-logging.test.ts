import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeConfig } from '../src/config/runtime-config.ts';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DISABLE_CONFIG_WATCHER =
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-runtime-config-'));
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
  delete config.container.sandboxMode;
  if (Array.isArray(config.scheduler?.jobs)) {
    for (const job of config.scheduler.jobs) {
      if (job?.schedule) {
        if (!Object.hasOwn(job.schedule, 'at')) {
          job.schedule.at = null;
        }
        if (!Object.hasOwn(job.schedule, 'everyMs')) {
          job.schedule.everyMs = null;
        }
      }
      if (job?.delivery && !Object.hasOwn(job.delivery, 'webhookUrl')) {
        job.delivery.webhookUrl = '';
      }
    }
  }
  mutator?.(config);
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

async function importFreshRuntimeConfig(homeDir: string): Promise<void> {
  process.env.HOME = homeDir;
  vi.resetModules();
  await import('../src/config/runtime-config.ts');
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

describe('runtime config migration logging', () => {
  it('does not log normalization on repeated startup once the file is canonical', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir);

    await importFreshRuntimeConfig(homeDir);
    vi.restoreAllMocks();
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    await importFreshRuntimeConfig(homeDir);

    expect(
      infoSpy.mock.calls.some(([message]) =>
        String(message).includes('normalized config schema v7'),
      ),
    ).toBe(false);
  });

  it('logs normalization when startup rewrites the config file', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir, (config) => {
      config.ops.dbPath = '~/.hybridclaw/data/hybridclaw.db';
    });
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    await importFreshRuntimeConfig(homeDir);

    expect(
      infoSpy.mock.calls.some(([message]) =>
        String(message).includes('normalized config schema v7'),
      ),
    ).toBe(true);
  });

  it('expands the legacy single-entry Codex model list on startup', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir, (config) => {
      config.codex.models = ['openai-codex/gpt-5-codex'];
    });

    await importFreshRuntimeConfig(homeDir);

    const stored = JSON.parse(
      fs.readFileSync(
        path.join(homeDir, '.hybridclaw', 'config.json'),
        'utf-8',
      ),
    ) as RuntimeConfig;

    expect(stored.codex.models).toEqual([
      'openai-codex/gpt-5-codex',
      'openai-codex/gpt-5.3-codex',
      'openai-codex/gpt-5.4',
      'openai-codex/gpt-5.3-codex-spark',
      'openai-codex/gpt-5.2-codex',
      'openai-codex/gpt-5.1-codex-max',
      'openai-codex/gpt-5.2',
      'openai-codex/gpt-5.1-codex-mini',
    ]);
  });

  it('does not start the fs watcher when watcher disable env is set', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir);
    process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
    const watchSpy = vi.spyOn(fs, 'watch');

    await importFreshRuntimeConfig(homeDir);

    expect(watchSpy).not.toHaveBeenCalled();
  });
});
