import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { sanitizeUploadedMediaFilename } from '../src/media/uploaded-media-cache.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../src/config/config.ts');
  vi.resetModules();
});

test('sanitizeUploadedMediaFilename keeps an existing extension', () => {
  expect(sanitizeUploadedMediaFilename(' Screen Shot.PNG ', 'image/jpeg')).toBe(
    'Screen-Shot.png',
  );
});

test('sanitizeUploadedMediaFilename infers a preferred extension when missing', () => {
  expect(sanitizeUploadedMediaFilename('clipboard image', 'image/png')).toBe(
    'clipboard-image.png',
  );
});

test('resolveUploadedMediaCacheHostDir follows DATA_DIR changes', async () => {
  vi.resetModules();
  let currentDataDir = '/tmp/hybridclaw-cache-a';

  vi.doMock('../src/config/config.ts', () => ({
    get CONTAINER_SANDBOX_MODE() {
      return 'container';
    },
    get DATA_DIR() {
      return currentDataDir;
    },
  }));

  const { resolveUploadedMediaCacheHostDir } = await import(
    '../src/media/uploaded-media-cache.js'
  );

  expect(resolveUploadedMediaCacheHostDir()).toBe(
    path.resolve('/tmp/hybridclaw-cache-a/uploaded-media-cache'),
  );

  currentDataDir = '/tmp/hybridclaw-cache-b';

  expect(resolveUploadedMediaCacheHostDir()).toBe(
    path.resolve('/tmp/hybridclaw-cache-b/uploaded-media-cache'),
  );
});
