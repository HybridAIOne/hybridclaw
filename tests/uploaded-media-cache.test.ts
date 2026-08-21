import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { sanitizeUploadedMediaFilename } from '../src/media/uploaded-media-cache.js';

const dataDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../src/config/config.ts');
  vi.resetModules();
  while (dataDirs.length > 0) {
    const dataDir = dataDirs.pop();
    if (!dataDir) continue;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
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

test('createUploadedMediaContextItem defaults url fields to the runtime path', async () => {
  vi.resetModules();
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-uploaded-media-host-'),
  );
  dataDirs.push(dataDir);

  vi.doMock('../src/config/config.ts', () => ({
    get CONTAINER_SANDBOX_MODE() {
      return 'host';
    },
    get DATA_DIR() {
      return dataDir;
    },
  }));

  const { createUploadedMediaContextItem } = await import(
    '../src/media/uploaded-media-cache.js'
  );

  const item = await createUploadedMediaContextItem({
    attachmentName: ' voice note.OGG ',
    buffer: Buffer.from('audio-bytes'),
    mimeType: 'audio/ogg; codecs=opus',
  });

  expect(item.path).toContain(path.join(dataDir, 'uploaded-media-cache'));
  expect(item.url).toBe(item.path);
  expect(item.originalUrl).toBe(item.path);
  expect(item.filename).toBe('voice-note.ogg');
  expect(item.sizeBytes).toBe(Buffer.byteLength('audio-bytes'));
  expect(fs.existsSync(item.path || '')).toBe(true);
});

test('createUploadedMediaContextItem preserves a provided originalUrl', async () => {
  vi.resetModules();
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-uploaded-media-container-'),
  );
  dataDirs.push(dataDir);

  vi.doMock('../src/config/config.ts', () => ({
    get CONTAINER_SANDBOX_MODE() {
      return 'container';
    },
    get DATA_DIR() {
      return dataDir;
    },
  }));

  const { createUploadedMediaContextItem, resolveUploadedMediaCacheHostDir } =
    await import('../src/media/uploaded-media-cache.js');

  const item = await createUploadedMediaContextItem({
    attachmentName: 'photo',
    buffer: Buffer.from([1, 2, 3]),
    mimeType: 'image/png',
    sizeBytes: 99,
    originalUrl: 'https://example.com/media/photo.png',
  });

  expect(item.path).toMatch(/^\/uploaded-media-cache\/\d{4}-\d{2}-\d{2}\//);
  expect(item.url).toBe('https://example.com/media/photo.png');
  expect(item.originalUrl).toBe('https://example.com/media/photo.png');
  expect(item.filename).toBe('photo.png');
  expect(item.sizeBytes).toBe(99);

  const hostPath = path.join(
    resolveUploadedMediaCacheHostDir(),
    item.path.replace(/^\/uploaded-media-cache\//, ''),
  );
  expect(fs.existsSync(hostPath)).toBe(true);
});

test('createUploadedMediaContextItemFromStream writes chunks without buffering the full upload', async () => {
  vi.resetModules();
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-uploaded-media-stream-'),
  );
  dataDirs.push(dataDir);

  vi.doMock('../src/config/config.ts', () => ({
    get CONTAINER_SANDBOX_MODE() {
      return 'host';
    },
    get DATA_DIR() {
      return dataDir;
    },
  }));

  const { createUploadedMediaContextItemFromStream } = await import(
    '../src/media/uploaded-media-cache.js'
  );
  async function* chunks(): AsyncGenerator<Uint8Array> {
    yield Buffer.from('streamed ');
    yield Buffer.from('content');
  }

  const item = await createUploadedMediaContextItemFromStream({
    attachmentName: 'notes.md',
    chunks: chunks(),
    maxBytes: 32,
    mimeType: 'text/markdown',
  });

  expect(item.sizeBytes).toBe(16);
  expect(fs.readFileSync(item.path || '', 'utf8')).toBe('streamed content');
});

test('createUploadedMediaContextItemFromStream removes partial files that exceed the limit', async () => {
  vi.resetModules();
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-uploaded-media-limit-'),
  );
  dataDirs.push(dataDir);

  vi.doMock('../src/config/config.ts', () => ({
    get CONTAINER_SANDBOX_MODE() {
      return 'host';
    },
    get DATA_DIR() {
      return dataDir;
    },
  }));

  const {
    createUploadedMediaContextItemFromStream,
    resolveUploadedMediaCacheHostDir,
    UPLOADED_MEDIA_CACHE_LIMIT_ERROR,
  } = await import('../src/media/uploaded-media-cache.js');
  async function* chunks(): AsyncGenerator<Uint8Array> {
    yield Buffer.from('123');
    yield Buffer.from('456');
  }

  await expect(
    createUploadedMediaContextItemFromStream({
      attachmentName: 'too-large.txt',
      chunks: chunks(),
      maxBytes: 5,
      mimeType: 'text/plain',
    }),
  ).rejects.toThrow(UPLOADED_MEDIA_CACHE_LIMIT_ERROR);

  const cacheDir = resolveUploadedMediaCacheHostDir();
  const cachedFiles = fs
    .readdirSync(cacheDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => fs.readdirSync(path.join(cacheDir, entry.name)));
  expect(cachedFiles).toEqual([]);
});
