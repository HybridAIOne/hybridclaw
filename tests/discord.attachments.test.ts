import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

const tempDirs: string[] = [];

function makeTempDataDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-discord-attachments-'),
  );
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock('../src/config/config.ts');
  vi.doUnmock('../src/logger.js');
  vi.resetModules();

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('buildAttachmentContext', () => {
  test('caches office attachments into the media context', async () => {
    const dataDir = makeTempDataDir();
    const fetchBody = Buffer.from('xlsx-payload', 'utf8');
    const fetchMock = vi.fn(async () => ({
      ok: true,
      headers: {
        get(name: string) {
          if (name === 'content-type') {
            return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
          }
          if (name === 'content-length') return String(fetchBody.length);
          return null;
        },
      },
      arrayBuffer: async () => fetchBody,
      text: async () => fetchBody.toString('utf8'),
    }));

    vi.stubGlobal('fetch', fetchMock);
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

    expect(fetchMock).toHaveBeenCalledTimes(1);
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
});
