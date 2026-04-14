import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempDataDir = useTempDir('hybridclaw-discord-cache-');

useCleanMocks({
  restoreAllMocks: true,
  resetModules: true,
  unmock: ['../src/config/config.ts', '../src/logger.js'],
});

describe('discord media cache helpers', () => {
  test('writeDiscordMediaCacheFile preserves unicode names and enforces permissions', async () => {
    const dataDir = makeTempDataDir();

    vi.doMock('../src/config/config.ts', () => ({
      CONTAINER_SANDBOX_MODE: 'container',
      DATA_DIR: dataDir,
    }));
    vi.doMock('../src/logger.js', () => ({
      logger: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
    }));

    const { sanitizeAttachmentFilename, writeDiscordMediaCacheFile } =
      await import('../src/channels/discord/media-cache.js');

    expect(
      sanitizeAttachmentFilename(
        '  Résumé квартал 非常に長い名前の資料 2026 final version ???.pdf  ',
      ),
    ).toMatch(/^[\p{L}\p{N}._-]+$/u);
    expect(
      sanitizeAttachmentFilename(
        'Résumé квартал 非常に長い名前の資料 2026 final version ???.pdf',
      ).length,
    ).toBeLessThanOrEqual(60);

    const result = await writeDiscordMediaCacheFile({
      attachmentName:
        'Résumé квартал 非常に長い名前の資料 2026 final version ???.pdf',
      buffer: Buffer.from('%PDF-1.7\n', 'utf8'),
      messageId: 'msg-1',
      order: 1,
    });

    expect(result.runtimePath).toMatch(
      /^\/discord-media-cache\/\d{4}-\d{2}-\d{2}\//,
    );
    expect(path.basename(result.hostPath)).toMatch(
      /Résumé-квартал-非常に長い名前の資料-2026-final-version\.pdf$/u,
    );

    const cacheRoot = path.join(dataDir, 'discord-media-cache');
    const rootStat = fs.statSync(cacheRoot);
    const fileStat = fs.statSync(result.hostPath);
    expect(rootStat.mode & 0o777).toBe(0o700);
    expect(fileStat.mode & 0o777).toBe(0o644);
  });

  test('cleanupDiscordMediaCache removes expired files and prunes empty date directories', async () => {
    const dataDir = makeTempDataDir();

    vi.doMock('../src/config/config.ts', () => ({
      CONTAINER_SANDBOX_MODE: 'container',
      DATA_DIR: dataDir,
    }));
    vi.doMock('../src/logger.js', () => ({
      logger: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
    }));

    const { cleanupDiscordMediaCache } = await import(
      '../src/channels/discord/media-cache.js'
    );

    const cacheRoot = path.join(dataDir, 'discord-media-cache');
    const expiredDir = path.join(cacheRoot, '2026-03-12');
    const freshDir = path.join(cacheRoot, '2026-03-13');
    const expiredFile = path.join(expiredDir, 'old.pdf');
    const freshFile = path.join(freshDir, 'fresh.pdf');

    fs.mkdirSync(expiredDir, { mode: 0o700, recursive: true });
    fs.mkdirSync(freshDir, { mode: 0o700, recursive: true });
    fs.writeFileSync(expiredFile, 'old');
    fs.writeFileSync(freshFile, 'fresh');

    const nowMs = Date.now();
    fs.utimesSync(
      expiredFile,
      new Date(nowMs - 2_000),
      new Date(nowMs - 2_000),
    );
    fs.utimesSync(freshFile, new Date(nowMs), new Date(nowMs));

    await cleanupDiscordMediaCache({
      nowMs,
      ttlMs: 1_000,
    });

    expect(fs.existsSync(expiredFile)).toBe(false);
    expect(fs.existsSync(expiredDir)).toBe(false);
    expect(fs.existsSync(freshFile)).toBe(true);
    expect(fs.existsSync(freshDir)).toBe(true);
  });

  test('triggerDiscordMediaCacheCleanup reuses an in-flight cleanup promise', async () => {
    const dataDir = makeTempDataDir();

    vi.doMock('../src/config/config.ts', () => ({
      CONTAINER_SANDBOX_MODE: 'container',
      DATA_DIR: dataDir,
    }));
    vi.doMock('../src/logger.js', () => ({
      logger: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
    }));

    const { triggerDiscordMediaCacheCleanup } = await import(
      '../src/channels/discord/media-cache.js'
    );

    const cacheRoot = path.join(dataDir, 'discord-media-cache');
    const expiredDir = path.join(cacheRoot, '2026-03-12');
    fs.mkdirSync(expiredDir, { mode: 0o700, recursive: true });
    const expiredFile = path.join(expiredDir, 'old.pdf');
    fs.writeFileSync(expiredFile, 'old');
    fs.utimesSync(expiredFile, new Date(0), new Date(0));

    const originalReaddir = fs.promises.readdir.bind(fs.promises);
    let releaseReaddir: (() => void) | null = null;
    const readdirGate = new Promise<void>((resolve) => {
      releaseReaddir = resolve;
    });

    const readdirSpy = vi
      .spyOn(fs.promises, 'readdir')
      .mockImplementation(async (target, options) => {
        if (
          String(target) === cacheRoot &&
          typeof options === 'object' &&
          options !== null &&
          'withFileTypes' in options &&
          options.withFileTypes === true
        ) {
          await readdirGate;
        }
        return originalReaddir(
          target as Parameters<typeof originalReaddir>[0],
          options as Parameters<typeof originalReaddir>[1],
        );
      });

    const first = triggerDiscordMediaCacheCleanup({
      force: true,
      nowMs: 10_000,
      ttlMs: 1,
    });
    const second = triggerDiscordMediaCacheCleanup({
      force: true,
      nowMs: 10_000,
      ttlMs: 1,
    });

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    await vi.waitFor(() => {
      expect(readdirSpy).toHaveBeenCalledTimes(1);
    });

    releaseReaddir?.();
    await first;

    expect(fs.existsSync(expiredFile)).toBe(false);
  });

  test('triggerDiscordMediaCacheCleanup uses nowMs for the throttle interval', async () => {
    const dataDir = makeTempDataDir();

    vi.doMock('../src/config/config.ts', () => ({
      CONTAINER_SANDBOX_MODE: 'container',
      DATA_DIR: dataDir,
    }));
    vi.doMock('../src/logger.js', () => ({
      logger: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
    }));

    const { triggerDiscordMediaCacheCleanup } = await import(
      '../src/channels/discord/media-cache.js'
    );

    const first = triggerDiscordMediaCacheCleanup({ nowMs: 10_000 });
    expect(first).not.toBeNull();
    await first;

    const throttled = triggerDiscordMediaCacheCleanup({ nowMs: 10_100 });
    expect(throttled).toBeNull();

    const afterInterval = triggerDiscordMediaCacheCleanup({
      nowMs: 10_000 + 5 * 60 * 1_000,
    });
    expect(afterInterval).not.toBeNull();
    await afterInterval;
  });
});
