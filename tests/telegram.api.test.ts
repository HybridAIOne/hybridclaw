import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('redacts the Telegram bot token from API transport errors', async () => {
  const token = '123456789:AA_secret_token';
  const leakedUrl = `https://api.telegram.org/bot${token}/getMe`;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError(`fetch failed for ${leakedUrl}`);
    }),
  );

  const { callTelegramApi } = await import('../src/channels/telegram/api.js');

  await expect(callTelegramApi(token, 'getMe')).rejects.toMatchObject({
    name: 'TypeError',
    message: `fetch failed for https://api.telegram.org/bot<redacted>/getMe`,
  });

  try {
    await callTelegramApi(token, 'getMe');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack || '' : '';
    expect(message).not.toContain(token);
    expect(stack).not.toContain(token);
  }
});

test('redacts the Telegram bot token from file download transport errors', async () => {
  const token = '123456789:AA_secret_token';
  const leakedUrl = `https://api.telegram.org/file/bot${token}/photos/image.jpg`;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError(`network error while fetching ${leakedUrl}`);
    }),
  );

  const { fetchTelegramFile } = await import('../src/channels/telegram/api.js');

  await expect(
    fetchTelegramFile(token, 'photos/image.jpg'),
  ).rejects.toMatchObject({
    name: 'TypeError',
    message:
      'network error while fetching https://api.telegram.org/file/bot<redacted>/photos/image.jpg',
  });

  try {
    await fetchTelegramFile(token, 'photos/image.jpg');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack || '' : '';
    expect(message).not.toContain(token);
    expect(stack).not.toContain(token);
  }
});

test('creates Telegram upload forms from a file-backed blob', async () => {
  const tempDir = makeTempDir('hybridclaw-telegram-api-');
  const filePath = path.join(tempDir, 'payload.txt');
  fs.writeFileSync(filePath, 'hello telegram', 'utf8');

  const { createTelegramUploadForm } = await import(
    '../src/channels/telegram/api.js'
  );
  const form = await createTelegramUploadForm({
    chatId: '123456789',
    fileField: 'document',
    filePath,
    filename: 'payload.txt',
    mimeType: 'text/plain',
    caption: 'payload',
  });

  const file = form.get('document');
  expect(file).toBeInstanceOf(Blob);
  expect(file).toBeInstanceOf(File);
  expect((file as Blob).size).toBe(14);
  expect((file as Blob).type).toBe('text/plain');
  expect(await (file as Blob).text()).toBe('hello telegram');
  expect(form.get('chat_id')).toBe('123456789');
  expect(form.get('caption')).toBe('payload');
});
