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
  const legacyScheduler = (
    config as unknown as { scheduler?: { jobs?: unknown[] } }
  ).scheduler;
  if (Array.isArray(legacyScheduler?.jobs)) {
    for (const job of legacyScheduler.jobs) {
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

type RuntimeConfigModule = typeof import('../src/config/runtime-config.ts');

async function importFreshRuntimeConfig(
  homeDir: string,
): Promise<RuntimeConfigModule> {
  process.env.HOME = homeDir;
  vi.resetModules();
  return import('../src/config/runtime-config.ts');
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

type WatchFilePollListener = (curr: fs.Stats, prev: fs.Stats) => void;

function stubWatchFilePolling() {
  const watchedPaths: string[] = [];
  let pollListener: WatchFilePollListener | undefined;
  const watchFileSpy = vi.spyOn(fs, 'watchFile').mockImplementation(((
    watchedPath: fs.PathLike,
    _options: unknown,
    onTick: WatchFilePollListener,
  ) => {
    watchedPaths.push(String(watchedPath));
    pollListener = onTick;
    return {} as fs.StatWatcher;
  }) as unknown as typeof fs.watchFile);
  const unwatchFileSpy = vi
    .spyOn(fs, 'unwatchFile')
    .mockImplementation(() => {});
  return {
    watchFileSpy,
    unwatchFileSpy,
    watchedPaths,
    emitPollTick: (curr: Partial<fs.Stats>, prev: Partial<fs.Stats>) => {
      pollListener?.(curr as fs.Stats, prev as fs.Stats);
    },
  };
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
  it('seeds fresh instances with Ollama disabled', async () => {
    const homeDir = makeTempHome();

    const runtimeConfig = await importFreshRuntimeConfig(homeDir);
    const stored = JSON.parse(
      fs.readFileSync(
        path.join(homeDir, '.hybridclaw', 'config.json'),
        'utf-8',
      ),
    ) as RuntimeConfig;

    expect(runtimeConfig.getRuntimeConfig().local.backends.ollama.enabled).toBe(
      false,
    );
    expect(stored.local.backends.ollama.enabled).toBe(false);
  });

  it('preserves explicitly enabled Ollama backends', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir, (config) => {
      config.local.backends.ollama.enabled = true;
    });

    const runtimeConfig = await importFreshRuntimeConfig(homeDir);

    expect(runtimeConfig.getRuntimeConfig().local.backends.ollama.enabled).toBe(
      true,
    );
  });

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

  it('warns on startup when cloud deployment is missing a public URL', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir, (config) => {
      config.deployment.mode = 'cloud';
      config.deployment.public_url = '';
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await importFreshRuntimeConfig(homeDir);

    expect(warnSpy).toHaveBeenCalledWith(
      '[runtime-config] deployment.mode is "cloud" but deployment.public_url is empty; inbound webhooks and public callbacks may fail until a public URL is configured',
    );
  });

  it('migrates legacy container additionalMounts into binds on startup', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir, (config) => {
      config.container.binds = ['/host/current:/current:ro'];
      (
        config.container as RuntimeConfig['container'] & {
          additionalMounts: string;
        }
      ).additionalMounts = JSON.stringify([
        {
          hostPath: '/host/legacy',
          containerPath: 'legacy',
          readonly: false,
        },
      ]);
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await importFreshRuntimeConfig(homeDir);

    const stored = JSON.parse(
      fs.readFileSync(
        path.join(homeDir, '.hybridclaw', 'config.json'),
        'utf-8',
      ),
    ) as RuntimeConfig & {
      container: RuntimeConfig['container'] & { additionalMounts?: unknown };
    };

    expect(stored.container.binds).toEqual([
      '/host/current:/current:ro',
      '/host/legacy:legacy:rw',
    ]);
    expect(stored.container.additionalMounts).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      '[runtime-config] migrated legacy container.additionalMounts into container.binds; update config.json to use container.binds before additionalMounts is removed',
    );
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

  it('preserves auth: oauth on remote MCP servers and drops it for stdio', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir, (config) => {
      config.mcpServers = {
        remote: {
          transport: 'http',
          url: 'https://example.com/mcp',
          auth: 'oauth',
          enabled: true,
        },
        local: {
          transport: 'stdio',
          command: 'node',
          enabled: true,
        },
      };
      (config.mcpServers.local as Record<string, unknown>).auth = 'oauth';
    });

    await importFreshRuntimeConfig(homeDir);

    const stored = JSON.parse(
      fs.readFileSync(
        path.join(homeDir, '.hybridclaw', 'config.json'),
        'utf-8',
      ),
    ) as RuntimeConfig;

    expect(stored.mcpServers.remote.auth).toBe('oauth');
    expect(stored.mcpServers.local.auth).toBeUndefined();
  });

  it('normalizes plugin config entries and drops invalid rows on startup', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir, (config) => {
      config.plugins.list = [
        {
          id: 'example-plugin',
          enabled: true,
          config: {
            workspaceId: 'workspace-a',
          },
        },
        {
          id: '',
          enabled: true,
          config: {},
        } as RuntimeConfig['plugins']['list'][number],
        {
          id: 'example-plugin',
          enabled: false,
          config: {
            workspaceId: 'workspace-b',
          },
        },
      ];
    });

    await importFreshRuntimeConfig(homeDir);

    const stored = JSON.parse(
      fs.readFileSync(
        path.join(homeDir, '.hybridclaw', 'config.json'),
        'utf-8',
      ),
    ) as RuntimeConfig;

    expect(stored.plugins.list).toEqual([
      {
        id: 'example-plugin',
        enabled: true,
        config: {
          workspaceId: 'workspace-a',
        },
      },
    ]);
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

  it('drops stale Codex model lists on startup', async () => {
    const homeDir = makeTempHome();
    const configPath = path.join(homeDir, '.hybridclaw', 'config.json');
    writeRuntimeConfig(homeDir);
    const raw = JSON.parse(
      fs.readFileSync(configPath, 'utf-8'),
    ) as RuntimeConfig;
    (raw.codex as Record<string, unknown>).models = [
      'openai-codex/gpt-5-codex',
    ];
    fs.writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');

    await importFreshRuntimeConfig(homeDir);

    const stored = JSON.parse(
      fs.readFileSync(
        path.join(homeDir, '.hybridclaw', 'config.json'),
        'utf-8',
      ),
    ) as RuntimeConfig;

    expect(stored.codex).not.toHaveProperty('models');
  });

  it('normalizes per-channel disabled skills on startup', async () => {
    const homeDir = makeTempHome();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeRuntimeConfig(homeDir, (config) => {
      (
        config.skills as RuntimeConfig['skills'] & {
          channelDisabled?: Record<string, unknown>;
        }
      ).channelDisabled = {
        discord: [' pdf ', '', 123],
        teams: 'apple-calendar, himalaya',
        unknown: ['code-review'],
        email: null,
      };
    });

    await importFreshRuntimeConfig(homeDir);

    const stored = JSON.parse(
      fs.readFileSync(
        path.join(homeDir, '.hybridclaw', 'config.json'),
        'utf-8',
      ),
    ) as RuntimeConfig;

    expect(stored.skills.channelDisabled).toEqual({
      discord: ['pdf'],
      email: [],
      msteams: ['apple-calendar', 'himalaya'],
    });
    expect(warnSpy).toHaveBeenCalledWith(
      '[runtime-config] ignored unknown skills.channelDisabled key: unknown',
    );
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

  it('does not start the fs watcher at module import, only on explicit start', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir);
    delete process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
    const fakeWatcher = createFakeWatcher();
    const watchSpy = vi
      .spyOn(fs, 'watch')
      .mockImplementation(() => fakeWatcher as unknown as fs.FSWatcher);

    const configMod = await importFreshRuntimeConfig(homeDir);

    expect(watchSpy).not.toHaveBeenCalled();

    configMod.startRuntimeConfigWatcher();
    configMod.startRuntimeConfigWatcher();

    expect(watchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not start the fs watcher when watcher disable env is set', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir);
    process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
    const watchSpy = vi.spyOn(fs, 'watch');

    const configMod = await importFreshRuntimeConfig(homeDir);
    configMod.startRuntimeConfigWatcher();

    expect(watchSpy).not.toHaveBeenCalled();
  });

  it('unrefs watcher timers so the watcher never keeps a process alive', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir);
    delete process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;

    const fakeWatcher = createFakeWatcher();
    vi.spyOn(fs, 'watch').mockImplementation(
      () => fakeWatcher as unknown as fs.FSWatcher,
    );

    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const unrefSpy = vi.fn();
    const clearSpy = vi.fn();

    vi.stubGlobal(
      'setTimeout',
      vi.fn((callback: () => void, _delay?: number) => ({
        callback,
        unref: unrefSpy,
      })),
    );
    vi.stubGlobal(
      'clearTimeout',
      vi.fn((timer: unknown) => {
        clearSpy(timer);
      }),
    );

    try {
      const configMod = await importFreshRuntimeConfig(homeDir);
      configMod.startRuntimeConfigWatcher();
    } finally {
      vi.stubGlobal('setTimeout', originalSetTimeout);
      vi.stubGlobal('clearTimeout', originalClearTimeout);
    }

    expect(unrefSpy).toHaveBeenCalled();
    expect(clearSpy).not.toHaveBeenCalled();
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
    stubWatchFilePolling();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const configMod = await importFreshRuntimeConfig(homeDir);
    configMod.startRuntimeConfigWatcher();

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
    stubWatchFilePolling();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const configMod = await importFreshRuntimeConfig(homeDir);
    configMod.startRuntimeConfigWatcher();

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

  it('falls back to stat polling when watcher setup fails and reloads config on poll ticks', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir);
    delete process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
    vi.useFakeTimers();
    vi.spyOn(fs, 'watch').mockImplementation(() => {
      throw Object.assign(new Error('EMFILE: too many open files, watch'), {
        code: 'EMFILE',
      });
    });
    const polling = stubWatchFilePolling();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const configMod = await importFreshRuntimeConfig(homeDir);
    configMod.startRuntimeConfigWatcher();

    expect(polling.watchFileSpy).toHaveBeenCalledTimes(1);
    expect(polling.watchedPaths).toEqual([
      path.join(homeDir, '.hybridclaw', 'config.json'),
    ]);
    expect(
      warnSpy.mock.calls.some(([message]) =>
        String(message).includes('stat polling'),
      ),
    ).toBe(true);

    writeRuntimeConfig(homeDir, (config) => {
      config.container.maxConcurrent = 7;
    });
    polling.emitPollTick({ mtimeMs: 2, size: 2 }, { mtimeMs: 1, size: 1 });
    await vi.advanceTimersByTimeAsync(200);

    expect(configMod.getRuntimeConfig().container.maxConcurrent).toBe(7);
  });

  it('stops stat polling once a restarted watcher becomes stable', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir);
    delete process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
    vi.useFakeTimers();
    let watchCalls = 0;
    vi.spyOn(fs, 'watch').mockImplementation(() => {
      watchCalls += 1;
      if (watchCalls === 1) {
        throw Object.assign(new Error('EMFILE: too many open files, watch'), {
          code: 'EMFILE',
        });
      }
      return createFakeWatcher() as unknown as fs.FSWatcher;
    });
    const polling = stubWatchFilePolling();
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const configMod = await importFreshRuntimeConfig(homeDir);
    configMod.startRuntimeConfigWatcher();

    expect(polling.watchFileSpy).toHaveBeenCalledTimes(1);
    expect(polling.unwatchFileSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(watchCalls).toBe(2);
    expect(polling.unwatchFileSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps stat polling active after watcher retries are exhausted', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir);
    delete process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
    vi.useFakeTimers();
    vi.spyOn(fs, 'watch').mockImplementation(() => {
      throw Object.assign(new Error('EMFILE: too many open files, watch'), {
        code: 'EMFILE',
      });
    });
    const polling = stubWatchFilePolling();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const configMod = await importFreshRuntimeConfig(homeDir);
    configMod.startRuntimeConfigWatcher();

    await vi.advanceTimersByTimeAsync(600_000);

    const disabledLog = warnSpy.mock.calls
      .map(([message]) => String(message))
      .find((message) => message.includes('watcher disabled after 10 retries'));
    expect(disabledLog).toBeDefined();
    expect(disabledLog).toContain('stat polling');
    expect(polling.watchFileSpy).toHaveBeenCalledTimes(1);
    expect(polling.unwatchFileSpy).not.toHaveBeenCalled();
  });
});
