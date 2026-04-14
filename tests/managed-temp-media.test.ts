import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempRoot = useTempDir('hybridclaw-managed-temp-');

useCleanMocks({
  resetModules: true,
  unmock: ['../src/logger.js'],
});

describe('managed temp media helpers', () => {
  test('resolveManagedTempMediaDir returns the managed temp directory root', async () => {
    vi.doMock('../src/logger.js', () => ({
      logger: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
    }));

    const {
      isManagedTempMediaPath,
      resolveManagedTempMediaDir,
      WHATSAPP_MEDIA_TMP_PREFIX,
    } = await import('../src/media/managed-temp-media.js');

    const tempRoot = makeTempRoot();
    const managedDir = fs.mkdtempSync(
      path.join(tempRoot, WHATSAPP_MEDIA_TMP_PREFIX),
    );
    const nestedDir = path.join(managedDir, 'nested');
    fs.mkdirSync(nestedDir, { recursive: true });
    const managedFile = path.join(nestedDir, 'voice.ogg');
    fs.writeFileSync(managedFile, 'audio');

    const unmanagedDir = fs.mkdtempSync(
      path.join(tempRoot, 'hybridclaw-other-'),
    );
    const unmanagedFile = path.join(unmanagedDir, 'note.txt');
    fs.writeFileSync(unmanagedFile, 'keep');

    expect(
      resolveManagedTempMediaDir({
        filePath: managedFile,
        rootDir: tempRoot,
      }),
    ).toBe(managedDir);
    expect(
      isManagedTempMediaPath({
        filePath: managedFile,
        rootDir: tempRoot,
      }),
    ).toBe(true);
    expect(
      resolveManagedTempMediaDir({
        filePath: unmanagedFile,
        rootDir: tempRoot,
      }),
    ).toBeNull();
  });

  test('cleanupManagedTempMediaDirectories removes matching temp dirs and symlinks only', async () => {
    vi.doMock('../src/logger.js', () => ({
      logger: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
    }));

    const { cleanupManagedTempMediaDirectories, WHATSAPP_MEDIA_TMP_PREFIX } =
      await import('../src/media/managed-temp-media.js');

    const tempRoot = makeTempRoot();
    const managedDir = fs.mkdtempSync(
      path.join(tempRoot, WHATSAPP_MEDIA_TMP_PREFIX),
    );
    fs.writeFileSync(path.join(managedDir, 'voice.ogg'), 'audio');

    const unmanagedDir = fs.mkdtempSync(
      path.join(tempRoot, 'hybridclaw-other-'),
    );
    fs.writeFileSync(path.join(unmanagedDir, 'note.txt'), 'keep');

    const managedLink = path.join(tempRoot, `${WHATSAPP_MEDIA_TMP_PREFIX}link`);
    fs.symlinkSync(unmanagedDir, managedLink);

    await cleanupManagedTempMediaDirectories({ rootDir: tempRoot });

    expect(fs.existsSync(managedDir)).toBe(false);
    expect(fs.existsSync(managedLink)).toBe(false);
    expect(fs.existsSync(unmanagedDir)).toBe(true);
  });
});
