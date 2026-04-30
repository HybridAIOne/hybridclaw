import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

const originalHome = process.env.HOME;
const originalDataDir = process.env.HYBRIDCLAW_DATA_DIR;
const originalDisableWatcher = process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
const tempHomes: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock('node:fs');
  vi.doUnmock('../src/logger.js');
  vi.resetModules();
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalDataDir === undefined) {
    delete process.env.HYBRIDCLAW_DATA_DIR;
  } else {
    process.env.HYBRIDCLAW_DATA_DIR = originalDataDir;
  }
  if (originalDisableWatcher === undefined) {
    delete process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
  } else {
    process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = originalDisableWatcher;
  }
  while (tempHomes.length > 0) {
    const tempHome = tempHomes.pop();
    if (!tempHome) continue;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('warns when warm pool min idle is clamped by max idle', async () => {
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  vi.doMock('../src/logger.js', () => ({ logger }));

  const tempHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-config-warm-pool-'),
  );
  tempHomes.push(tempHome);
  vi.stubEnv('HOME', tempHome);
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', tempHome);
  vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
  fs.writeFileSync(
    path.join(tempHome, 'config.json'),
    JSON.stringify({
      container: {
        warmPool: {
          enabled: true,
          minIdlePerActiveAgent: 5,
          maxIdlePerAgent: 2,
        },
      },
    }),
    'utf-8',
  );

  const { CONTAINER_WARM_POOL } = await import('../src/config/config.ts');

  expect(CONTAINER_WARM_POOL.minIdlePerActiveAgent).toBe(5);
  expect(CONTAINER_WARM_POOL.maxIdlePerAgent).toBe(2);
  expect(logger.warn).toHaveBeenCalledWith(
    {
      requestedMinIdlePerActiveAgent: 5,
      maxIdlePerAgent: 2,
      effectiveMinIdlePerActiveAgent: 2,
    },
    'Warm process pool minIdlePerActiveAgent exceeds maxIdlePerAgent; clamping effective minimum idle workers',
  );
});

test('warns once when all app-version package probes fail', async () => {
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  vi.doMock('../src/logger.js', () => ({ logger }));

  vi.doMock('node:fs', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    const readFileSync = vi.fn(
      (filePath: fs.PathOrFileDescriptor, ...args: unknown[]) => {
        const normalized = String(filePath);
        if (
          normalized.endsWith(`${path.sep}package.json`) ||
          normalized.endsWith('/package.json')
        ) {
          throw new Error('ENOENT');
        }
        return Reflect.apply(actual.readFileSync, actual, [
          filePath,
          ...args,
        ]) as ReturnType<typeof fs.readFileSync>;
      },
    );
    return {
      ...actual,
      default: {
        ...actual,
        readFileSync,
      },
      readFileSync,
    };
  });

  const tempHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-config-version-'),
  );
  tempHomes.push(tempHome);
  vi.stubEnv('HOME', tempHome);
  vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
  vi.stubEnv('npm_package_version', '');

  const { APP_VERSION } = await import('../src/config/config.ts');

  expect(APP_VERSION).toBe('0.0.0');
  expect(logger.warn).toHaveBeenCalledTimes(1);
  expect(logger.warn).toHaveBeenCalledWith(
    {
      probePaths: expect.arrayContaining([
        expect.stringMatching(/package\.json$/),
      ]),
    },
    'Unable to resolve app version from package.json probes; falling back to 0.0.0',
  );
});
