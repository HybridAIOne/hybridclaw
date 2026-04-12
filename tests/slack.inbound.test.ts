import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import {
  cleanupSlackInboundMedia,
  evaluateSlackAccessPolicy,
  processInboundSlackEvent,
  resolveSlackManagedMediaDirectory,
} from '../src/channels/slack/inbound.ts';
import * as slackTarget from '../src/channels/slack/target.ts';
import type { RuntimeSlackConfig } from '../src/config/runtime-config.ts';
import { logger } from '../src/logger.ts';
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

test('processInboundSlackEvent starts Slack attachment downloads in parallel', async () => {
  tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-slack-inbound-'),
  );
  vi.spyOn(os, 'tmpdir').mockReturnValue(tempRoot);

  const resolvers: Array<(value: Response) => void> = [];
  const fetchSpy = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        resolvers.push(resolve);
      }),
  );
  vi.stubGlobal('fetch', fetchSpy);

  const inboundPromise = processInboundSlackEvent({
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
          url_private_download:
            'https://files.slack.com/files-pri/T1-F1/first.txt',
        },
        {
          name: 'second.txt',
          mimetype: 'text/plain',
          size: 3,
          url_private_download:
            'https://files.slack.com/files-pri/T1-F2/second.txt',
        },
      ],
    },
    botUserId: 'U9999999999',
    config: createSlackConfig(),
    activeThreadKeys: new Set(),
    botToken: 'xoxb-test-token',
  });

  expect(fetchSpy).toHaveBeenCalledTimes(2);
  expect(resolvers).toHaveLength(2);

  resolvers[0](new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
  resolvers[1](new Response(new Uint8Array([4, 5, 6]), { status: 200 }));

  const inbound = await inboundPromise;
  expect(inbound?.media).toHaveLength(2);
});

test('processInboundSlackEvent downloads attachments into managed temp media and cleanup removes them', async () => {
  tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-slack-inbound-'),
  );
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
          url_private_download:
            'https://files.slack.com/files-pri/T1-F1/report.pdf',
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

test('processInboundSlackEvent streams attachment downloads without calling arrayBuffer', async () => {
  tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-slack-inbound-'),
  );
  vi.spyOn(os, 'tmpdir').mockReturnValue(tempRoot);
  const arrayBufferSpy = vi.fn(async () => new ArrayBuffer(0));

  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
      }),
      arrayBuffer: arrayBufferSpy,
    })),
  );

  const inbound = await processInboundSlackEvent({
    event: {
      channel: 'D1234567890',
      channel_type: 'im',
      ts: '1710000000.123456',
      user: 'U1234567890',
      files: [
        {
          name: 'report.pdf',
          mimetype: 'application/pdf',
          size: 3,
          url_private_download:
            'https://files.slack.com/files-pri/T1-F1/report.pdf',
        },
      ],
    },
    botUserId: 'U9999999999',
    config: createSlackConfig(),
    activeThreadKeys: new Set(),
    botToken: 'xoxb-test-token',
  });

  expect(inbound?.media).toHaveLength(1);
  expect(arrayBufferSpy).not.toHaveBeenCalled();
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
  tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-slack-inbound-'),
  );
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
            url_private_download:
              'https://files.slack.com/files-pri/T1-F1/first.txt',
          },
          {
            name: 'second.txt',
            mimetype: 'text/plain',
            size: 3,
            url_private_download:
              'https://files.slack.com/files-pri/T1-F2/second.txt',
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

test('processInboundSlackEvent warns when a downloaded attachment exceeds the max size', async () => {
  tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-slack-inbound-'),
  );
  vi.spyOn(os, 'tmpdir').mockReturnValue(tempRoot);
  const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(new Uint8Array(1_048_577), {
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
      files: [
        {
          name: 'too-large.bin',
          mimetype: 'application/octet-stream',
          size: 1,
          url_private_download:
            'https://files.slack.com/files-pri/T1-F1/too-large.bin',
        },
      ],
    },
    botUserId: 'U9999999999',
    config: createSlackConfig({ mediaMaxMb: 1 }),
    activeThreadKeys: new Set(),
    botToken: 'xoxb-test-token',
  });

  expect(inbound).toBeNull();
  expect(warnSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      filename: 'too-large.bin',
      sizeBytes: 1_048_577,
    }),
    'Slack attachment exceeded max size after download',
  );
});

test('evaluateSlackAccessPolicy caches normalized allow-lists across repeated checks', () => {
  const normalizeSpy = vi.spyOn(slackTarget, 'normalizeSlackUserId');
  const allowFrom = ['U1234567890', 'U2222222222'];

  expect(
    evaluateSlackAccessPolicy({
      dmPolicy: 'allowlist',
      groupPolicy: 'disabled',
      allowFrom,
      groupAllowFrom: [],
      userId: 'U1234567890',
      isDm: true,
    }),
  ).toBe(true);
  expect(
    evaluateSlackAccessPolicy({
      dmPolicy: 'allowlist',
      groupPolicy: 'disabled',
      allowFrom,
      groupAllowFrom: [],
      userId: 'U2222222222',
      isDm: true,
    }),
  ).toBe(true);

  expect(normalizeSpy).toHaveBeenCalledTimes(2);
});
