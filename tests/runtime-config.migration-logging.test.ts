import { EventEmitter } from 'node:events';
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

type FakeWatcher = EventEmitter &
  fs.FSWatcher & {
    close: ReturnType<typeof vi.fn>;
  };

function createFakeWatcher(): FakeWatcher {
  const watcher = new EventEmitter() as FakeWatcher;
  watcher.close = vi.fn();
  return watcher;
}

afterEach(() => {
  vi.useRealTimers();
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
        String(message).includes('[runtime-config] normalized config schema'),
      ),
    ).toBe(false);
  });

  it('logs normalization when startup rewrites the config file', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir, (config) => {
      config.version = 10;
      config.ops.dbPath = '~/.hybridclaw/data/hybridclaw.db';
    });
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    await importFreshRuntimeConfig(homeDir);
    const stored = JSON.parse(
      fs.readFileSync(
        path.join(homeDir, '.hybridclaw', 'config.json'),
        'utf-8',
      ),
    ) as RuntimeConfig;

    expect(
      infoSpy.mock.calls.some(
        ([message]) =>
          String(message).includes(
            `[runtime-config] migrated config schema from v10 to v${stored.version}`,
          ) ||
          String(message).includes(
            `[runtime-config] normalized config schema v${stored.version}`,
          ),
      ),
    ).toBe(true);
  });

  it('normalizes MCP server transport aliases on startup', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir, (config) => {
      config.mcpServers = {
        demo: {
          transport: 'stdio',
          command: 'node',
          enabled: true,
        },
      };
      (config.mcpServers.demo as Record<string, unknown>).transport =
        'streamable-http';
      (config.mcpServers.demo as Record<string, unknown>).url =
        'https://example.com/mcp';
      delete (config.mcpServers.demo as Record<string, unknown>).command;
    });

    await importFreshRuntimeConfig(homeDir);

    const stored = JSON.parse(
      fs.readFileSync(
        path.join(homeDir, '.hybridclaw', 'config.json'),
        'utf-8',
      ),
    ) as RuntimeConfig;

    expect(stored.mcpServers.demo.transport).toBe('http');
    expect(stored.mcpServers.demo.url).toBe('https://example.com/mcp');
  });

  it('drops MCP servers that are invalid for their selected transport', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir, (config) => {
      config.mcpServers = {
        brokenStdio: {
          transport: 'stdio',
          enabled: true,
        } as RuntimeConfig['mcpServers'][string],
        brokenHttp: {
          transport: 'http',
          enabled: true,
        } as RuntimeConfig['mcpServers'][string],
        validSse: {
          transport: 'sse',
          url: 'https://example.com/mcp',
          enabled: true,
        },
      };
    });

    await importFreshRuntimeConfig(homeDir);

    const stored = JSON.parse(
      fs.readFileSync(
        path.join(homeDir, '.hybridclaw', 'config.json'),
        'utf-8',
      ),
    ) as RuntimeConfig;

    expect(Object.keys(stored.mcpServers)).toEqual(['validSse']);
    expect(stored.mcpServers.validSse.transport).toBe('sse');
    expect(stored.mcpServers.validSse.url).toBe('https://example.com/mcp');
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

  it('normalizes the legacy Teams dm pairing policy to allowlist on startup', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir, (config) => {
      if (!config.msteams) {
        config.msteams = {
          enabled: false,
          appId: '',
          tenantId: '',
          webhook: { port: 3978, path: '/api/msteams/messages' },
          groupPolicy: 'open',
          dmPolicy: 'open',
          allowFrom: [],
          teams: {},
          requireMention: true,
          textChunkLimit: 4000,
          replyStyle: 'thread',
          mediaMaxMb: 20,
          dangerouslyAllowNameMatching: false,
          mediaAllowHosts: [],
          mediaAuthAllowHosts: [],
        };
      }
      (
        config.msteams as RuntimeConfig['msteams'] & { dmPolicy: string }
      ).dmPolicy = 'pairing';
    });

    await importFreshRuntimeConfig(homeDir);

    const stored = JSON.parse(
      fs.readFileSync(
        path.join(homeDir, '.hybridclaw', 'config.json'),
        'utf-8',
      ),
    ) as RuntimeConfig;

    expect(stored.msteams.dmPolicy).toBe('allowlist');
  });

  it('strips legacy Teams app passwords from config on startup', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir, (config) => {
      if (!config.msteams) {
        config.msteams = {
          enabled: false,
          appId: '',
          tenantId: '',
          webhook: { port: 3978, path: '/api/msteams/messages' },
          groupPolicy: 'open',
          dmPolicy: 'open',
          allowFrom: [],
          teams: {},
          requireMention: true,
          textChunkLimit: 4000,
          replyStyle: 'thread',
          mediaMaxMb: 20,
          dangerouslyAllowNameMatching: false,
          mediaAllowHosts: [],
          mediaAuthAllowHosts: [],
        };
      }
      (
        config.msteams as RuntimeConfig['msteams'] & { appPassword?: string }
      ).appPassword = 'plaintext-secret';
    });

    await importFreshRuntimeConfig(homeDir);

    const stored = JSON.parse(
      fs.readFileSync(
        path.join(homeDir, '.hybridclaw', 'config.json'),
        'utf-8',
      ),
    ) as RuntimeConfig & { msteams: { appPassword?: string } };

    expect(stored.msteams.appPassword).toBeUndefined();
  });

  it('does not start the fs watcher when watcher disable env is set', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir);
    process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
    const watchSpy = vi.spyOn(fs, 'watch');

    await importFreshRuntimeConfig(homeDir);

    expect(watchSpy).not.toHaveBeenCalled();
  });

  it('disables the fs watcher without retrying when watch descriptors are exhausted', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir);
    delete process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
    const watchError = Object.assign(
      new Error('EMFILE: too many open files, watch'),
      {
        code: 'EMFILE',
      },
    );
    const watchSpy = vi.spyOn(fs, 'watch').mockImplementation(() => {
      throw watchError;
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await importFreshRuntimeConfig(homeDir);

    expect(watchSpy).toHaveBeenCalledTimes(1);
    expect(
      warnSpy.mock.calls.some(([message]) =>
        String(message).includes(
          '[runtime-config] watcher disabled: EMFILE: too many open files, watch',
        ),
      ),
    ).toBe(true);
    expect(
      warnSpy.mock.calls.some(([message]) =>
        String(message).includes('[runtime-config] watcher restart in'),
      ),
    ).toBe(false);
  });

  it('disables the fs watcher without retrying when the watcher emits an async EMFILE error', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir);
    delete process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
    vi.useFakeTimers();
    const watchError = Object.assign(
      new Error('EMFILE: too many open files, watch'),
      {
        code: 'EMFILE',
      },
    );
    const fakeWatcher = new EventEmitter() as EventEmitter &
      fs.FSWatcher & {
        close: ReturnType<typeof vi.fn>;
      };
    fakeWatcher.close = vi.fn();
    const watchSpy = vi
      .spyOn(fs, 'watch')
      .mockImplementation(() => fakeWatcher as unknown as fs.FSWatcher);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await importFreshRuntimeConfig(homeDir);

    setTimeout(() => {
      fakeWatcher.emit('error', watchError);
    }, 0);
    await vi.runAllTimersAsync();

    expect(watchSpy).toHaveBeenCalledTimes(1);
    expect(fakeWatcher.close).toHaveBeenCalledTimes(1);
    expect(
      warnSpy.mock.calls.some(([message]) =>
        String(message).includes(
          '[runtime-config] watcher disabled: EMFILE: too many open files, watch',
        ),
      ),
    ).toBe(true);
    expect(
      warnSpy.mock.calls.some(([message]) =>
        String(message).includes('[runtime-config] watcher restart in'),
      ),
    ).toBe(false);
  });

  it('increments retry attempts when restarted watchers fail before they become stable', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir);
    delete process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
    vi.useFakeTimers();
    const retryableError = Object.assign(
      new Error('EIO: transient watch failure'),
      {
        code: 'EIO',
      },
    );
    const watchers: FakeWatcher[] = [];
    const watchSpy = vi.spyOn(fs, 'watch').mockImplementation(() => {
      const watcher = createFakeWatcher();
      watchers.push(watcher);
      return watcher as unknown as fs.FSWatcher;
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await importFreshRuntimeConfig(homeDir);

    setTimeout(() => {
      watchers[0]?.emit('error', retryableError);
    }, 0);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);

    setTimeout(() => {
      watchers[1]?.emit('error', retryableError);
    }, 0);
    await vi.advanceTimersByTimeAsync(0);

    const restartLogs = warnSpy.mock.calls
      .map(([message]) => String(message))
      .filter((message) =>
        message.includes('[runtime-config] watcher restart in'),
      );

    expect(watchSpy).toHaveBeenCalledTimes(2);
    expect(
      restartLogs.filter((message) => message.includes('attempt 1/10')),
    ).toHaveLength(1);
    expect(
      restartLogs.filter((message) => message.includes('attempt 2/10')),
    ).toHaveLength(1);
  });

  it('resets retry attempts after a restarted watcher stays healthy without file activity', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir);
    delete process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
    vi.useFakeTimers();
    const retryableError = Object.assign(
      new Error('EIO: transient watch failure'),
      {
        code: 'EIO',
      },
    );
    const watchers: FakeWatcher[] = [];
    const watchSpy = vi.spyOn(fs, 'watch').mockImplementation(() => {
      const watcher = createFakeWatcher();
      watchers.push(watcher);
      return watcher as unknown as fs.FSWatcher;
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await importFreshRuntimeConfig(homeDir);

    setTimeout(() => {
      watchers[0]?.emit('error', retryableError);
    }, 0);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    setTimeout(() => {
      watchers[1]?.emit('error', retryableError);
    }, 0);
    await vi.advanceTimersByTimeAsync(0);

    const restartLogs = warnSpy.mock.calls
      .map(([message]) => String(message))
      .filter((message) =>
        message.includes('[runtime-config] watcher restart in'),
      );

    expect(watchSpy).toHaveBeenCalledTimes(2);
    expect(
      restartLogs.filter((message) => message.includes('attempt 1/10')),
    ).toHaveLength(2);
    expect(
      restartLogs.filter((message) => message.includes('attempt 2/10')),
    ).toHaveLength(0);
  });
});
