import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_DATA_DIR = process.env.HYBRIDCLAW_DATA_DIR;
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DISABLE_CONFIG_WATCHER =
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;

let tmpDir: string;
let configPath: string;

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function importFreshRuntimeConfig() {
  vi.resetModules();
  const runtimeConfig = await import('../src/config/runtime-config.js');
  const configChecks = await import('../src/doctor/checks/config.js');
  return { runtimeConfig, checkConfigFile: configChecks.checkConfigFile };
}

function readDiskConfig(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<
    string,
    unknown
  >;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-deployment-config-'));
  configPath = path.join(tmpDir, 'config.json');
  process.env.HYBRIDCLAW_DATA_DIR = tmpDir;
  process.env.HOME = tmpDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
});

afterEach(() => {
  vi.resetModules();
  restoreEnvVar('HYBRIDCLAW_DATA_DIR', ORIGINAL_DATA_DIR);
  restoreEnvVar('HOME', ORIGINAL_HOME);
  restoreEnvVar(
    'HYBRIDCLAW_DISABLE_CONFIG_WATCHER',
    ORIGINAL_DISABLE_CONFIG_WATCHER,
  );
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe('runtime deployment config', () => {
  it('seeds local deployment mode with an operator-managed tunnel provider', async () => {
    const { runtimeConfig } = await importFreshRuntimeConfig();

    expect(runtimeConfig.getRuntimeConfig().deployment).toEqual({
      mode: 'local',
      public_url: '',
      tunnel: {
        provider: 'manual',
      },
    });
    expect(readDiskConfig().deployment).toEqual({
      mode: 'local',
      public_url: '',
      tunnel: {
        provider: 'manual',
      },
    });
  });

  it('validates cloud mode requires deployment.public_url', async () => {
    const { runtimeConfig, checkConfigFile } = await importFreshRuntimeConfig();
    runtimeConfig.updateRuntimeConfig((draft) => {
      draft.deployment.mode = 'cloud';
      draft.deployment.public_url = '';
    });

    const results = await checkConfigFile();

    expect(results).toHaveLength(1);
    expect(results[0]?.severity).toBe('error');
    expect(results[0]?.message).toContain('deployment.public_url');
  });

  it('validates local mode requires deployment.tunnel.provider', async () => {
    const { runtimeConfig, checkConfigFile } = await importFreshRuntimeConfig();
    runtimeConfig.updateRuntimeConfig((draft) => {
      draft.deployment.mode = 'local';
      draft.deployment.tunnel.provider = '';
    });

    const results = await checkConfigFile();

    expect(results).toHaveLength(1);
    expect(results[0]?.severity).toBe('error');
    expect(results[0]?.message).toContain('deployment.tunnel.provider');
  });

  it('validates deployment.mode values from disk', async () => {
    const { checkConfigFile } = await importFreshRuntimeConfig();
    const config = readDiskConfig();
    config.deployment = {
      mode: 'managed',
      public_url: '',
      tunnel: {
        provider: 'manual',
      },
    };
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const results = await checkConfigFile();

    expect(results).toHaveLength(1);
    expect(results[0]?.severity).toBe('error');
    expect(results[0]?.message).toContain('deployment.mode');
  });

  it('persists deployment updates through runtime config revisions', async () => {
    const { runtimeConfig } = await importFreshRuntimeConfig();

    runtimeConfig.updateRuntimeConfig(
      (draft) => {
        draft.deployment.mode = 'cloud';
        draft.deployment.public_url = 'https://bot.example.com/';
        draft.deployment.tunnel.provider = 'cloudflare';
      },
      {
        actor: 'test-user',
        route: 'test.deployment.update',
        source: 'internal',
      },
    );

    expect(runtimeConfig.getRuntimeConfig().deployment).toEqual({
      mode: 'cloud',
      public_url: 'https://bot.example.com',
      tunnel: {
        provider: 'cloudflare',
      },
    });
    expect(readDiskConfig().deployment).toEqual({
      mode: 'cloud',
      public_url: 'https://bot.example.com',
      tunnel: {
        provider: 'cloudflare',
      },
    });
    const revisions = runtimeConfig.listRuntimeConfigRevisions();
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      actor: 'test-user',
      route: 'test.deployment.update',
      source: 'internal',
    });
    expect(
      runtimeConfig.getRuntimeConfigRevision(revisions[0]?.id ?? -1)?.content,
    ).toContain('"deployment"');
    const revisionId = revisions[0]?.id;
    if (!revisionId) {
      throw new Error('Expected deployment config revision id.');
    }

    const restored = runtimeConfig.restoreRuntimeConfigRevision(revisionId, {
      actor: 'test-user',
      route: `test.deployment.rollback#${revisionId}`,
      source: 'internal',
    });

    expect(restored.deployment).toEqual({
      mode: 'local',
      public_url: '',
      tunnel: {
        provider: 'manual',
      },
    });
    expect(readDiskConfig().deployment).toEqual({
      mode: 'local',
      public_url: '',
      tunnel: {
        provider: 'manual',
      },
    });
  });
});
