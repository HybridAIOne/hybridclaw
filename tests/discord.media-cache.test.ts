import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

const tempDirs: string[] = [];

function makeTempDataDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-discord-cache-'),
  );
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../src/config/config.ts');
  vi.doUnmock('../src/logger.js');
  vi.resetModules();

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { force: true, recursive: true });
  }
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
});
