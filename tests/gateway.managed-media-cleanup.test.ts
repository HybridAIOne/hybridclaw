import { afterEach, describe, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../src/channels/discord/media-cache.ts');
  vi.doUnmock('../src/logger.js');
  vi.doUnmock('../src/media/managed-temp-media.ts');
  vi.doUnmock('../src/media/uploaded-media-cache.ts');
  vi.resetModules();
});

describe('runManagedMediaCleanup', () => {
  test('runs Discord cache and managed temp cleanup on startup', async () => {
    const triggerDiscordMediaCacheCleanup = vi.fn(() => Promise.resolve());
    const startUploadedMediaCacheCleanup = vi.fn(() => Promise.resolve());
    const cleanupManagedTempMediaDirectories = vi.fn(() => Promise.resolve());
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };

    vi.doMock('../src/channels/discord/media-cache.ts', () => ({
      triggerDiscordMediaCacheCleanup,
    }));
    vi.doMock('../src/media/uploaded-media-cache.ts', () => ({
      startUploadedMediaCacheCleanup,
    }));
    vi.doMock('../src/media/managed-temp-media.ts', () => ({
      cleanupManagedTempMediaDirectories,
    }));
    vi.doMock('../src/logger.js', () => ({ logger }));

    const { runManagedMediaCleanup } = await import(
      '../src/gateway/managed-media-cleanup.js'
    );

    await runManagedMediaCleanup('startup');

    expect(triggerDiscordMediaCacheCleanup).toHaveBeenCalledWith({
      force: true,
    });
    expect(startUploadedMediaCacheCleanup).toHaveBeenCalledWith({
      force: true,
    });
    expect(cleanupManagedTempMediaDirectories).toHaveBeenCalledWith();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('runs only Discord cache cleanup on shutdown', async () => {
    const triggerDiscordMediaCacheCleanup = vi.fn(() => Promise.resolve());
    const startUploadedMediaCacheCleanup = vi.fn(() => Promise.resolve());
    const cleanupManagedTempMediaDirectories = vi.fn(() => Promise.resolve());

    vi.doMock('../src/channels/discord/media-cache.ts', () => ({
      triggerDiscordMediaCacheCleanup,
    }));
    vi.doMock('../src/media/uploaded-media-cache.ts', () => ({
      startUploadedMediaCacheCleanup,
    }));
    vi.doMock('../src/media/managed-temp-media.ts', () => ({
      cleanupManagedTempMediaDirectories,
    }));
    vi.doMock('../src/logger.js', () => ({
      logger: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
    }));

    const { runManagedMediaCleanup } = await import(
      '../src/gateway/managed-media-cleanup.js'
    );

    await runManagedMediaCleanup('shutdown');

    expect(triggerDiscordMediaCacheCleanup).toHaveBeenCalledWith({
      force: true,
    });
    expect(startUploadedMediaCacheCleanup).toHaveBeenCalledWith({
      force: true,
    });
    expect(cleanupManagedTempMediaDirectories).not.toHaveBeenCalled();
  });

  test('logs each cleanup failure against the correct task', async () => {
    const discordError = new Error('discord failed');
    const uploadedError = new Error('uploaded failed');
    const managedTempError = new Error('managed temp failed');
    const triggerDiscordMediaCacheCleanup = vi.fn(() =>
      Promise.reject(discordError),
    );
    const startUploadedMediaCacheCleanup = vi.fn(() =>
      Promise.reject(uploadedError),
    );
    const cleanupManagedTempMediaDirectories = vi.fn(() =>
      Promise.reject(managedTempError),
    );
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };

    vi.doMock('../src/channels/discord/media-cache.ts', () => ({
      triggerDiscordMediaCacheCleanup,
    }));
    vi.doMock('../src/media/uploaded-media-cache.ts', () => ({
      startUploadedMediaCacheCleanup,
    }));
    vi.doMock('../src/media/managed-temp-media.ts', () => ({
      cleanupManagedTempMediaDirectories,
    }));
    vi.doMock('../src/logger.js', () => ({ logger }));

    const { runManagedMediaCleanup } = await import(
      '../src/gateway/managed-media-cleanup.js'
    );

    await runManagedMediaCleanup('startup');

    expect(logger.warn).toHaveBeenCalledWith(
      { error: discordError, reason: 'startup' },
      'Discord media cache cleanup failed',
    );
    expect(logger.warn).toHaveBeenCalledWith(
      { error: uploadedError, reason: 'startup' },
      'Uploaded media cache cleanup failed',
    );
    expect(logger.warn).toHaveBeenCalledWith(
      { error: managedTempError, reason: 'startup' },
      'Managed temp media cleanup failed',
    );
  });
});
