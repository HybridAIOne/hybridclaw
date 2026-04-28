/**
 * Integration test: Config loading, validation, and update cycle.
 *
 * Writes real config.json files to a temp directory, sets HYBRIDCLAW_DATA_DIR
 * to point there, and tests reloadRuntimeConfig / getRuntimeConfig /
 * updateRuntimeConfig with real filesystem I/O.
 *
 * The file watcher is intentionally disabled (HYBRIDCLAW_DISABLE_CONFIG_WATCHER=1)
 * because watcher-based tests are too flaky for CI.
 */

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

function writeConfig(obj: unknown): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(obj, null, 2), 'utf-8');
}

function readConfigFromDisk(): unknown {
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

beforeAll(() => {
  originalDataDir = process.env.HYBRIDCLAW_DATA_DIR;
  originalHome = process.env.HOME;
  originalWatcher = process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
});

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-cfg-integration-'));
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
    // best-effort
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

describe('config reload integration', () => {
  it('reloadRuntimeConfig reads config.json and populates runtime values', () => {
    writeConfig({
      discord: { prefix: '!test' },
      ops: { healthPort: 7777 },
    });
    const cfg = configMod.reloadRuntimeConfig('test');
    expect(cfg.discord.prefix).toBe('!test');
    expect(cfg.ops.healthPort).toBe(7777);
  });

  it('missing config.json yields default config after ensureRuntimeConfigFile', () => {
    // Remove any config.json that ensureRuntimeConfigFile may have seeded.
    if (fs.existsSync(configPath)) fs.unlinkSync(configPath);

    configMod.ensureRuntimeConfigFile();

    // A default config file should have been written.
    expect(fs.existsSync(configPath)).toBe(true);

    const cfg = configMod.getRuntimeConfig();
    // Default healthPort should be the standard default (9090).
    expect(cfg.ops.healthPort).toBe(9090);
    expect(cfg.container.persistBashState).toBe(true);
  });

  it('invalid JSON in config.json throws descriptive error', () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '{ not valid json !!!', 'utf-8');

    expect(() => configMod.reloadRuntimeConfig('test')).toThrow();
  });

  it('updateRuntimeConfig writes changes atomically', () => {
    // Ensure a base config exists.
    configMod.ensureRuntimeConfigFile();

    configMod.updateRuntimeConfig((draft) => {
      draft.discord.prefix = '!!updated';
    });

    // Verify the change persisted to disk.
    const diskConfig = readConfigFromDisk() as {
      discord?: { prefix?: string };
    };
    expect(diskConfig.discord?.prefix).toBe('!!updated');

    // And is reflected in the in-memory config.
    expect(configMod.getRuntimeConfig().discord.prefix).toBe('!!updated');
  });

  it('config with unknown keys is accepted (forward-compatible)', () => {
    writeConfig({
      unknownFutureKey: 'hello',
      discord: { prefix: '!forward' },
    });

    const cfg = configMod.reloadRuntimeConfig('test');
    expect(cfg.discord.prefix).toBe('!forward');
    // Should not throw — unknown keys are silently ignored.
  });

  it('config with invalid types falls back to defaults', () => {
    writeConfig({
      ops: { healthPort: 'abc' },
    });

    const cfg = configMod.reloadRuntimeConfig('test');
    // Invalid port string should fall back to default (9090).
    expect(cfg.ops.healthPort).toBe(9090);
  });

  it('reloadRuntimeConfig accepts container.persistBashState=false', () => {
    writeConfig({
      container: { persistBashState: false },
    });

    const cfg = configMod.reloadRuntimeConfig('test');
    expect(cfg.container.persistBashState).toBe(false);
  });

  it('normalizes per-agent skill autonomy rules', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeConfig({
      skills: {
        autonomy: {
          defaultLevel: 'low-stakes-autonomous',
          rules: [
            'not-a-rule',
            {
              agentId: ' writer ',
              skillName: ' docs ',
              level: 'full-autonomous',
            },
            {
              agentId: 'writer',
              skillName: 'email',
              level: 'confirm-each',
            },
            {
              agentId: '',
              skillName: 'ignored',
              level: 'full-autonomous',
            },
            {
              agentId: 'writer',
              skillName: 'bad-level',
              level: 'unsupported',
            },
          ],
        },
      },
    });

    const cfg = configMod.reloadRuntimeConfig('test');

    expect(cfg.skills.autonomy).toEqual({
      defaultLevel: 'low-stakes-autonomous',
      rules: [
        {
          agentId: 'writer',
          skillName: 'bad-level',
          level: 'low-stakes-autonomous',
        },
        {
          agentId: 'writer',
          skillName: 'docs',
          level: 'full-autonomous',
        },
        {
          agentId: 'writer',
          skillName: 'email',
          level: 'confirm-each',
        },
      ],
    });
    expect(configMod.resolveSkillAutonomyLevel(cfg, 'writer', 'docs')).toBe(
      'full-autonomous',
    );
    expect(configMod.resolveSkillAutonomyLevel(cfg, 'writer', 'missing')).toBe(
      'low-stakes-autonomous',
    );
    expect(warnSpy).toHaveBeenCalledWith(
      '[runtime-config] skipping skills.autonomy rule: expected an object',
    );
    expect(warnSpy).toHaveBeenCalledWith(
      '[runtime-config] skipping skills.autonomy rule with empty agentId or skillName',
    );
    warnSpy.mockRestore();
  });

  it('keeps autonomy rules distinct when ids contain null bytes', () => {
    writeConfig({
      skills: {
        autonomy: {
          rules: [
            {
              agentId: 'team\u0000alpha',
              skillName: 'docs',
              level: 'full-autonomous',
            },
            {
              agentId: 'team',
              skillName: 'alpha\u0000docs',
              level: 'low-stakes-autonomous',
            },
          ],
        },
      },
    });

    const cfg = configMod.reloadRuntimeConfig('test');

    expect(
      configMod.resolveSkillAutonomyLevel(cfg, 'team\u0000alpha', 'docs'),
    ).toBe('full-autonomous');
    expect(
      configMod.resolveSkillAutonomyLevel(cfg, 'team', 'alpha\u0000docs'),
    ).toBe('low-stakes-autonomous');
  });

  it('nested config updates do not clobber sibling keys', () => {
    configMod.ensureRuntimeConfigFile();

    configMod.updateRuntimeConfig((draft) => {
      draft.discord.prefix = '!first';
    });

    configMod.updateRuntimeConfig((draft) => {
      draft.discord.textChunkLimit = 1500;
    });

    const cfg = configMod.getRuntimeConfig();
    // The prefix update from the first call should still be present.
    expect(cfg.discord.prefix).toBe('!first');
    expect(cfg.discord.textChunkLimit).toBe(1500);
  });
});
