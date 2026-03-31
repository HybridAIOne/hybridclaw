import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

let tmpDir: string;
let configPath: string;
let originalDataDir: string | undefined;
let originalHome: string | undefined;
let originalWatcher: string | undefined;

type RuntimeConfigModule = typeof import('../src/config/runtime-config.js');
let configMod: RuntimeConfigModule;

function readDiskConfig(): { discord?: { prefix?: string } } {
  return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
    discord?: { prefix?: string };
  };
}

beforeAll(() => {
  originalDataDir = process.env.HYBRIDCLAW_DATA_DIR;
  originalHome = process.env.HOME;
  originalWatcher = process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
});

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-cfg-revisions-'));
  configPath = path.join(tmpDir, 'config.json');

  process.env.HYBRIDCLAW_DATA_DIR = tmpDir;
  process.env.HOME = tmpDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';

  vi.resetModules();
  configMod = await import('../src/config/runtime-config.js');
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.HYBRIDCLAW_DATA_DIR;
  else process.env.HYBRIDCLAW_DATA_DIR = originalDataDir;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalWatcher === undefined)
    delete process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
  else process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = originalWatcher;
});

describe('runtime config revisions integration', () => {
  it('stores the previous config snapshot when HybridClaw updates config.json', () => {
    configMod.ensureRuntimeConfigFile();

    configMod.updateRuntimeConfig(
      (draft) => {
        draft.discord.prefix = '!one';
      },
      {
        actor: 'cli-user',
        route: 'cli.config.set:discord.prefix',
        source: 'internal',
      },
    );

    const revisions = configMod.listRuntimeConfigRevisions();
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      actor: 'cli-user',
      route: 'cli.config.set:discord.prefix',
      source: 'internal',
    });
    expect(revisions[0]?.md5).toMatch(/^[a-f0-9]{32}$/);
  });

  it('sanitizes stack-derived routes when no explicit route metadata is provided', () => {
    configMod.ensureRuntimeConfigFile();

    configMod.updateRuntimeConfig((draft) => {
      draft.discord.prefix = '!implicit-route';
    });

    const revisions = configMod.listRuntimeConfigRevisions();
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.route).toBeTruthy();
    expect(revisions[0]?.route).not.toContain(tmpDir);
    expect(revisions[0]?.route).not.toContain('/Users/');
    expect(revisions[0]?.route).not.toContain('/private/');
  });

  it('stores the previous config snapshot when config.json is edited manually and reloaded', () => {
    configMod.ensureRuntimeConfigFile();
    configMod.updateRuntimeConfig((draft) => {
      draft.discord.prefix = '!before-manual';
    });

    const manualConfig = {
      ...readDiskConfig(),
      discord: {
        ...(readDiskConfig().discord ?? {}),
        prefix: '!manual-edit',
      },
    };
    fs.writeFileSync(
      configPath,
      `${JSON.stringify(manualConfig, null, 2)}\n`,
      'utf-8',
    );

    const reloaded = configMod.reloadRuntimeConfig('manual-test');
    const revisions = configMod.listRuntimeConfigRevisions();

    expect(reloaded.discord.prefix).toBe('!manual-edit');
    expect(revisions[0]).toMatchObject({
      route: 'runtime-config.reload:manual-test',
      source: 'external',
    });
  });

  it('restores and clears config revisions', () => {
    configMod.ensureRuntimeConfigFile();

    configMod.updateRuntimeConfig((draft) => {
      draft.discord.prefix = '!first';
    });
    configMod.updateRuntimeConfig((draft) => {
      draft.discord.prefix = '!second';
    });

    const revisions = configMod.listRuntimeConfigRevisions();
    const firstRevision = revisions.find((revision) =>
      configMod
        .getRuntimeConfigRevision(revision.id)
        ?.content.includes('"prefix": "!first"'),
    );
    expect(firstRevision).toBeTruthy();
    if (!firstRevision) {
      throw new Error('Expected a revision containing the first saved prefix.');
    }

    const restored = configMod.restoreRuntimeConfigRevision(firstRevision.id, {
      actor: 'cli-user',
      route: `cli.config.revisions.rollback#${firstRevision.id}`,
      source: 'internal',
    });

    expect(restored.discord.prefix).toBe('!first');
    expect(readDiskConfig().discord?.prefix).toBe('!first');

    const cleared = configMod.clearRuntimeConfigRevisions();
    expect(cleared).toBeGreaterThan(0);
    expect(configMod.listRuntimeConfigRevisions()).toHaveLength(0);
    expect(fs.existsSync(configMod.runtimeConfigRevisionPath())).toBe(true);
  });
});
