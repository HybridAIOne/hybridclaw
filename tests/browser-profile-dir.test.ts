import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test, vi } from 'vitest';

import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir('hybridclaw-browser-profile-dir-');
useCleanMocks({
  restoreAllMocks: true,
  unstubAllEnvs: true,
  resetModules: true,
  unmock: ['../src/logger.js'],
});

async function loadWithFailingChmod(initialMode: number) {
  const home = makeTempDir();
  vi.stubEnv('HOME', home);
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', path.join(home, '.hybridclaw'));
  vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
  const warn = vi.fn();
  vi.doMock('../src/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
  }));
  const { ensureBrowserProfileHostDir } = await import(
    '../src/browser/profile-dir.js'
  );
  const { getBrowserProfileDir } = await import(
    '../src/browser/browser-login.js'
  );
  const { DATA_DIR } = await import('../src/config/config.js');
  const dir = path.resolve(getBrowserProfileDir(DATA_DIR));
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, initialMode);
  vi.spyOn(fs, 'chmodSync').mockImplementation(() => {
    throw Object.assign(new Error('operation not permitted'), {
      code: 'EPERM',
    });
  });
  return { ensureBrowserProfileHostDir, warn, dir };
}

describe.runIf(process.platform !== 'win32')('ensureBrowserProfileHostDir', () => {
  test('warns once when the profile dir cannot be made owner-only', async () => {
    const { ensureBrowserProfileHostDir, warn, dir } =
      await loadWithFailingChmod(0o755);

    expect(ensureBrowserProfileHostDir()).toBe(dir);
    ensureBrowserProfileHostDir();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ dir }),
      expect.any(String),
    );
  });

  test('stays quiet when chmod fails on a dir that is already owner-only', async () => {
    const { ensureBrowserProfileHostDir, warn } =
      await loadWithFailingChmod(0o700);

    ensureBrowserProfileHostDir();

    expect(warn).not.toHaveBeenCalled();
  });
});
