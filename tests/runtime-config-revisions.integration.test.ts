import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
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

  it('reloads config.json with a single file read while syncing revisions', () => {
    configMod.ensureRuntimeConfigFile();

    const readFileSpy = vi.spyOn(fs, 'readFileSync');
    readFileSpy.mockClear();

    configMod.reloadRuntimeConfig('single-read-test');

    const configReads = readFileSpy.mock.calls.filter(
      ([filePath]) => String(filePath) === configPath,
    );
    expect(configReads).toHaveLength(1);
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

  it('migrates the revision store for typed runtime assets', () => {
    const database = new Database(configMod.runtimeConfigRevisionPath(), {
      readonly: true,
    });
    try {
      const revisionColumns = database
        .prepare(`PRAGMA table_info(config_revisions)`)
        .all() as Array<{ name: string }>;
      const stateColumns = database
        .prepare(`PRAGMA table_info(config_revision_state)`)
        .all() as Array<{ name: string; pk: number }>;

      expect(
        revisionColumns.some((column) => column.name === 'asset_type'),
      ).toBe(true);
      expect(stateColumns.some((column) => column.name === 'asset_type')).toBe(
        true,
      );
      expect(
        stateColumns.find((column) => column.name === 'asset_type')?.pk,
      ).toBe(1);
      expect(
        stateColumns.find((column) => column.name === 'config_path')?.pk,
      ).toBe(2);
      expect(database.pragma('user_version', { simple: true })).toBe(2);
    } finally {
      database.close();
    }
  });

  it('migrates legacy config revision rows into typed asset storage', async () => {
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-cfg-v1-'));
    const legacyDbPath = path.join(legacyDir, 'data', 'config-revisions.db');
    const legacyConfigPath = path.join(legacyDir, 'config.json');
    fs.mkdirSync(path.dirname(legacyDbPath), { recursive: true });
    const database = new Database(legacyDbPath);
    try {
      database.exec(`
        CREATE TABLE config_revisions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          config_path TEXT NOT NULL,
          actor TEXT NOT NULL,
          route TEXT NOT NULL,
          source TEXT NOT NULL,
          md5 TEXT NOT NULL,
          byte_length INTEGER NOT NULL,
          content TEXT NOT NULL,
          replaced_by_md5 TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE config_revision_state (
          config_path TEXT PRIMARY KEY,
          current_md5 TEXT NOT NULL,
          current_content TEXT NOT NULL,
          actor TEXT NOT NULL,
          route TEXT NOT NULL,
          source TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        PRAGMA user_version = 1;
      `);
      database
        .prepare(
          `INSERT INTO config_revisions (
            config_path, actor, route, source, md5, byte_length, content, replaced_by_md5, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          legacyConfigPath,
          'legacy-user',
          'legacy.update',
          'internal',
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          13,
          '{"version":1}',
          null,
          '2026-04-27T00:00:00.000Z',
        );
      database
        .prepare(
          `INSERT INTO config_revision_state (
            config_path, current_md5, current_content, actor, route, source, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          legacyConfigPath,
          'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          '{"version":2}',
          'legacy-user',
          'legacy.state',
          'internal',
          '2026-04-27T00:01:00.000Z',
        );
    } finally {
      database.close();
    }

    process.env.HYBRIDCLAW_DATA_DIR = legacyDir;
    process.env.HOME = legacyDir;
    vi.resetModules();
    const revisionsMod = await import(
      '../src/config/runtime-config-revisions.js'
    );

    const revisions = revisionsMod.listRuntimeConfigRevisions(legacyConfigPath);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      assetType: 'config',
      actor: 'legacy-user',
      route: 'legacy.update',
    });
    expect(
      revisionsMod.getRuntimeConfigRevisionState(legacyConfigPath)?.content,
    ).toBe('{"version":2}');

    const skillPath = path.join(legacyDir, 'skills', 'demo', 'SKILL.md');
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, 'first\n', 'utf-8');
    revisionsMod.syncRuntimeAssetRevisionState('skill', skillPath);
    fs.writeFileSync(skillPath, 'second\n', 'utf-8');
    revisionsMod.syncRuntimeAssetRevisionState('skill', skillPath);
    expect(
      revisionsMod.listRuntimeAssetRevisions('skill', skillPath),
    ).toHaveLength(1);
  });

  it.each([
    ['skill', 'skills/research/SKILL.md'],
    ['knowledge', 'knowledge/sales/index.md'],
    ['cv', 'agents/charly/CV.md'],
    ['classifier', 'classifiers/nda/weights.json'],
  ] as const)('restores %s runtime asset revisions', (assetType, relativePath) => {
    const restoreRevision = {
      skill: configMod.restoreRuntimeSkillRevision,
      knowledge: configMod.restoreRuntimeKnowledgeRevision,
      cv: configMod.restoreRuntimeCvRevision,
      classifier: configMod.restoreRuntimeClassifierRevision,
    }[assetType];
    const assetPath = path.join(tmpDir, relativePath);
    fs.mkdirSync(path.dirname(assetPath), { recursive: true });
    fs.writeFileSync(assetPath, `${assetType}: first\n`, 'utf-8');

    configMod.syncRuntimeAssetRevisionState(assetType, assetPath, {
      actor: 'asset-test',
      route: `test.${assetType}.seed`,
      source: 'internal',
    });

    fs.writeFileSync(assetPath, `${assetType}: second\n`, 'utf-8');
    configMod.syncRuntimeAssetRevisionState(assetType, assetPath, {
      actor: 'asset-test',
      route: `test.${assetType}.update`,
      source: 'internal',
    });

    const revisions = configMod.listRuntimeAssetRevisions(assetType, assetPath);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      assetType,
      route: `test.${assetType}.update`,
    });

    const restoredContent = restoreRevision(assetPath, revisions[0].id, {
      actor: 'asset-test',
      route: `test.${assetType}.rollback`,
      source: 'internal',
    });

    expect(restoredContent).toBe(`${assetType}: first\n`);
    expect(fs.readFileSync(assetPath, 'utf-8')).toBe(`${assetType}: first\n`);
    expect(
      configMod.getLastKnownGoodRuntimeAssetState(assetType, assetPath)
        ?.content,
    ).toBe(`${assetType}: first\n`);
  });
});
