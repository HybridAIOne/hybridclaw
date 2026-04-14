import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempDataDir = useTempDir('hybridclaw-discord-attachments-');

useCleanMocks({
  restoreAllMocks: true,
  resetModules: true,
  unstubAllGlobals: true,
  unmock: [
    '../src/channels/discord/discord-cdn-fetch.js',
    '../src/config/config.ts',
    '../src/logger.js',
  ],
});

describe('buildAttachmentContext', () => {
  test('caches PDF attachments into the media context', async () => {
    const dataDir = makeTempDataDir();
    const fetchBody = Buffer.from('%PDF-1.7\n', 'utf8');
    const fetchDiscordCdnBufferMock = vi.fn(async () => ({
      body: fetchBody,
      contentLength: fetchBody.length,
      contentType: 'application/pdf',
      url: 'https://cdn.discordapp.com/attachments/1/2/spec.pdf',
    }));

    vi.doMock('../src/channels/discord/discord-cdn-fetch.js', () => ({
      fetchDiscordCdnBuffer: fetchDiscordCdnBufferMock,
      fetchDiscordCdnText: vi.fn(),
      isSafeDiscordCdnUrl: vi.fn(() => true),
    }));
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

    const { buildAttachmentContext } = await import(
      '../src/channels/discord/attachments.js'
    );

    const attachment = {
      contentType: 'application/pdf',
      id: 'att-pdf-1',
      name: 'spec.pdf',
      proxyURL: 'https://media.discordapp.net/attachments/1/2/spec.pdf',
      size: fetchBody.length,
      url: 'https://cdn.discordapp.com/attachments/1/2/spec.pdf',
    };
    const message = {
      attachments: new Map([[attachment.id, attachment]]),
      id: 'msg-pdf-1',
    };

    const result = await buildAttachmentContext([message as never]);

    expect(fetchDiscordCdnBufferMock).toHaveBeenCalledTimes(1);
    expect(result.context).toContain('[Attachments]');
    expect(result.context).toContain('spec.pdf: PDF attachment cached');
    expect(result.media).toHaveLength(1);
    expect(result.media[0]).toMatchObject({
      filename: 'spec.pdf',
      mimeType: 'application/pdf',
      path: expect.stringMatching(/^\/discord-media-cache\//),
      sizeBytes: fetchBody.length,
    });
  });

  test('caches office attachments into the media context', async () => {
    const dataDir = makeTempDataDir();
    const fetchBody = Buffer.from('xlsx-payload', 'utf8');
    const fetchDiscordCdnBufferMock = vi.fn(async () => ({
      body: fetchBody,
      contentLength: fetchBody.length,
      contentType:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      url: 'https://cdn.discordapp.com/attachments/1/2/financials.xlsx',
    }));

    vi.doMock('../src/channels/discord/discord-cdn-fetch.js', () => ({
      fetchDiscordCdnBuffer: fetchDiscordCdnBufferMock,
      fetchDiscordCdnText: vi.fn(),
      isSafeDiscordCdnUrl: vi.fn(() => true),
    }));
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

    const { buildAttachmentContext } = await import(
      '../src/channels/discord/attachments.js'
    );

    const attachment = {
      contentType:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      id: 'att-1',
      name: 'financials.xlsx',
      proxyURL: 'https://media.discordapp.net/attachments/1/2/financials.xlsx',
      size: fetchBody.length,
      url: 'https://cdn.discordapp.com/attachments/1/2/financials.xlsx',
    };
    const message = {
      attachments: new Map([[attachment.id, attachment]]),
      id: 'msg-1',
    };

    const result = await buildAttachmentContext([message as never]);

    expect(fetchDiscordCdnBufferMock).toHaveBeenCalledTimes(1);
    expect(result.context).toContain('[Attachments]');
    expect(result.context).toContain(
      'financials.xlsx: office attachment cached',
    );
    expect(result.media).toHaveLength(1);
    expect(result.media[0]).toMatchObject({
      filename: 'financials.xlsx',
      mimeType:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      path: expect.stringMatching(/^\/discord-media-cache\//),
      sizeBytes: fetchBody.length,
    });

    const cacheRoot = path.join(dataDir, 'discord-media-cache');
    const cachedFile = fs
      .readdirSync(cacheRoot, { recursive: true })
      .find((entry) => String(entry).endsWith('financials.xlsx'));
    expect(cachedFile).toBeTruthy();
  });

  test('caches audio attachments into the media context', async () => {
    const dataDir = makeTempDataDir();
    const fetchBody = Buffer.from('ogg-payload', 'utf8');
    const fetchDiscordCdnBufferMock = vi.fn(async () => ({
      body: fetchBody,
      contentLength: fetchBody.length,
      contentType: 'audio/ogg; codecs=opus',
      url: 'https://cdn.discordapp.com/attachments/1/2/voice-note.ogg',
    }));

    vi.doMock('../src/channels/discord/discord-cdn-fetch.js', () => ({
      fetchDiscordCdnBuffer: fetchDiscordCdnBufferMock,
      fetchDiscordCdnText: vi.fn(),
      isSafeDiscordCdnUrl: vi.fn(() => true),
    }));
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

    const { buildAttachmentContext } = await import(
      '../src/channels/discord/attachments.js'
    );

    const attachment = {
      contentType: 'audio/ogg; codecs=opus',
      id: 'att-voice-1',
      name: 'voice-note.ogg',
      proxyURL: 'https://media.discordapp.net/attachments/1/2/voice-note.ogg',
      size: fetchBody.length,
      url: 'https://cdn.discordapp.com/attachments/1/2/voice-note.ogg',
    };
    const message = {
      attachments: new Map([[attachment.id, attachment]]),
      id: 'msg-voice-1',
    };

    const result = await buildAttachmentContext([message as never]);

    expect(fetchDiscordCdnBufferMock).toHaveBeenCalledTimes(1);
    expect(result.context).toContain('[Attachments]');
    expect(result.context).toContain('voice-note.ogg: audio attachment cached');
    expect(result.media).toHaveLength(1);
    expect(result.media[0]).toMatchObject({
      filename: 'voice-note.ogg',
      mimeType: 'audio/ogg',
      path: expect.stringMatching(/^\/discord-media-cache\//),
      sizeBytes: fetchBody.length,
    });
  });

  test('applies the tighter image size limit before fetching', async () => {
    const dataDir = makeTempDataDir();
    const fetchDiscordCdnBufferMock = vi.fn();

    vi.doMock('../src/channels/discord/discord-cdn-fetch.js', () => ({
      fetchDiscordCdnBuffer: fetchDiscordCdnBufferMock,
      fetchDiscordCdnText: vi.fn(),
      isSafeDiscordCdnUrl: vi.fn(() => true),
    }));
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

    const { buildAttachmentContext } = await import(
      '../src/channels/discord/attachments.js'
    );

    const attachment = {
      contentType: 'image/png',
      id: 'att-image-1',
      name: 'diagram.png',
      proxyURL: 'https://media.discordapp.net/attachments/1/2/diagram.png',
      size: 7 * 1024 * 1024,
      url: 'https://cdn.discordapp.com/attachments/1/2/diagram.png',
    };
    const message = {
      attachments: new Map([[attachment.id, attachment]]),
      id: 'msg-image-1',
    };

    const result = await buildAttachmentContext([message as never]);

    expect(fetchDiscordCdnBufferMock).not.toHaveBeenCalled();
    expect(result.context).toContain('diagram.png: skipped');
    expect(result.context).toContain('exceeds 6MB limit');
    expect(result.media).toEqual([
      expect.objectContaining({
        filename: 'diagram.png',
        path: null,
        sizeBytes: 7 * 1024 * 1024,
      }),
    ]);
  });
});
