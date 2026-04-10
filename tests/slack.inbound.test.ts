import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

import type { RuntimeSlackConfig } from '../src/config/runtime-config.ts';
import {
  cleanupSlackInboundMedia,
  processInboundSlackEvent,
  resolveSlackManagedMediaDirectory,
} from '../src/channels/slack/inbound.ts';
import type { MediaContextItem } from '../src/types/container.ts';

let tempRoot: string | null = null;

function createSlackConfig(
  overrides?: Partial<RuntimeSlackConfig>,
): RuntimeSlackConfig {
  return {
    enabled: true,
    groupPolicy: 'open',
    dmPolicy: 'open',
    allowFrom: [],
    groupAllowFrom: [],
    requireMention: true,
    textChunkLimit: 4_000,
    replyStyle: 'thread',
    mediaMaxMb: 20,
    ...overrides,
  };
}

function makeSlackMediaItem(filePath: string): MediaContextItem {
  const filename = path.basename(filePath);
  const url = `file://${filePath}`;
  return {
    path: filePath,
    url,
    originalUrl: url,
    mimeType: 'text/plain',
    sizeBytes: 2,
    filename,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

test('processInboundSlackEvent downloads attachments into managed temp media and cleanup removes them', async () => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-slack-inbound-'));
  vi.spyOn(os, 'tmpdir').mockReturnValue(tempRoot);
  const rootDir = tempRoot;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
        }),
    ),
  );

  const inbound = await processInboundSlackEvent({
    event: {
      channel: 'D1234567890',
      channel_type: 'im',
      ts: '1710000000.123456',
      user: 'U1234567890',
      text: '<@U9999999999> hello slack',
      files: [
        {
          name: 'report.pdf',
          mimetype: 'application/pdf',
          size: 3,
          url_private_download: 'https://files.slack.com/files-pri/T1-F1/report.pdf',
        },
      ],
    },
    botUserId: 'U9999999999',
    config: createSlackConfig(),
    activeThreadKeys: new Set(),
    botToken: 'xoxb-test-token',
  });

  expect(inbound).not.toBeNull();
  expect(inbound?.content).toBe('hello slack');
  expect(inbound?.channelId).toBe('slack:D1234567890');
  expect(inbound?.media).toHaveLength(1);

  const attachmentPath = inbound?.media[0]?.path;
  expect(attachmentPath).toBeTruthy();
  expect(attachmentPath?.startsWith(rootDir)).toBe(true);
  expect(resolveSlackManagedMediaDirectory(attachmentPath)).toBe(
    path.dirname(attachmentPath as string),
  );
  expect(fs.existsSync(attachmentPath as string)).toBe(true);

  await cleanupSlackInboundMedia(inbound?.media || []);

  expect(fs.existsSync(path.dirname(attachmentPath as string))).toBe(false);
});

test('cleanupSlackInboundMedia ignores files outside managed Slack temp directories', async () => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-nonmanaged-'));
  const safeDir = path.join(tempRoot, 'plain-dir');
  fs.mkdirSync(safeDir, { recursive: true });
  const safeFile = path.join(safeDir, 'note.txt');
  fs.writeFileSync(safeFile, 'ok');

  expect(resolveSlackManagedMediaDirectory(safeFile)).toBeNull();

  await cleanupSlackInboundMedia([makeSlackMediaItem(safeFile)]);

  expect(fs.existsSync(safeDir)).toBe(true);
  expect(fs.existsSync(safeFile)).toBe(true);
});

test('processInboundSlackEvent removes partial temp media when a later download fails', async () => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-slack-inbound-'));
  vi.spyOn(os, 'tmpdir').mockReturnValue(tempRoot);
  const rootDir = tempRoot;

  let fetchCalls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }
      throw new Error('network failed');
    }),
  );

  await expect(
    processInboundSlackEvent({
      event: {
        channel: 'D1234567890',
        channel_type: 'im',
        ts: '1710000000.123456',
        user: 'U1234567890',
        files: [
          {
            name: 'first.txt',
            mimetype: 'text/plain',
            size: 3,
            url_private_download: 'https://files.slack.com/files-pri/T1-F1/first.txt',
          },
          {
            name: 'second.txt',
            mimetype: 'text/plain',
            size: 3,
            url_private_download: 'https://files.slack.com/files-pri/T1-F2/second.txt',
          },
        ],
      },
      botUserId: 'U9999999999',
      config: createSlackConfig(),
      activeThreadKeys: new Set(),
      botToken: 'xoxb-test-token',
    }),
  ).rejects.toThrow('network failed');

  expect(fs.readdirSync(rootDir)).toEqual([]);
});
