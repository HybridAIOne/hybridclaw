import fs from 'node:fs';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir('hybridclaw-media-host-path-');
useCleanMocks({
  unstubAllEnvs: true,
  resetModules: true,
  unmock: ['../src/config/config.js'],
});

test('maps the Discord media cache under the data dir current at resolve time', async () => {
  const home = makeTempDir();
  vi.stubEnv('HOME', home);
  vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
  let dataDir = path.join(home, 'data-a');
  vi.doMock('../src/config/config.js', async (importOriginal) =>
    Object.defineProperties(
      { ...(await importOriginal<typeof import('../src/config/config.js')>()) },
      { DATA_DIR: { get: () => dataDir, enumerable: true } },
    ),
  );
  const { createMediaHostPathResolver, resolveDiscordMediaCacheHostDir } =
    await import('../src/media/media-host-path.js');
  const workspace = makeTempDir();

  dataDir = path.join(home, 'data-b');
  const cacheFile = path.join(resolveDiscordMediaCacheHostDir(), 'photo.png');
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, 'png');

  expect(resolveDiscordMediaCacheHostDir()).toBe(
    path.join(home, 'data-b', 'discord-media-cache'),
  );
  await expect(
    createMediaHostPathResolver(workspace)('/discord-media-cache/photo.png'),
  ).resolves.toBe(fs.realpathSync(cacheFile));
});
