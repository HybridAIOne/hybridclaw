import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

const tempDirs: string[] = [];

async function importAttachmentsModule() {
  vi.resetModules();
  vi.doMock('../src/config/config.js', () => ({
    MSTEAMS_MEDIA_ALLOW_HOSTS: [
      '*.trafficmanager.net',
      '*.blob.core.windows.net',
      'asm.skype.com',
    ],
    MSTEAMS_MEDIA_AUTH_ALLOW_HOSTS: ['graph.microsoft.com'],
    MSTEAMS_MEDIA_MAX_MB: 20,
  }));
  return import('../src/channels/msteams/attachments.js');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildTeamsUploadedFileAttachment uploads the file through Bot Framework', async () => {
  const { buildTeamsUploadedFileAttachment } = await importAttachmentsModule();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-msteams-'));
  tempDirs.push(tempDir);
  const filePath = path.join(tempDir, 'hybridclaw-homepage.png');
  fs.writeFileSync(filePath, Buffer.from([1, 2, 3, 4]));

  const uploadAttachment = vi.fn(async () => ({ id: 'attachment-123' }));
  const connectorKey = Symbol('ConnectorClientKey');
  const turnContext = {
    activity: {
      conversation: { id: 'conversation-123' },
      serviceUrl: 'https://smba.trafficmanager.net/de/tenant-id/',
    },
    adapter: {
      ConnectorClientKey: connectorKey,
    },
    turnState: new Map([
      [
        connectorKey,
        {
          conversations: {
            uploadAttachment,
          },
        },
      ],
    ]),
  };

  const attachment = await buildTeamsUploadedFileAttachment({
    turnContext: turnContext as never,
    filePath,
    mimeType: 'image/png',
  });

  expect(uploadAttachment).toHaveBeenCalledWith(
    'conversation-123',
    expect.objectContaining({
      name: 'hybridclaw-homepage.png',
      originalBase64: expect.any(Uint8Array),
      thumbnailBase64: expect.any(Uint8Array),
      type: 'image/png',
    }),
  );
  expect(attachment).toEqual({
    contentType: 'image/png',
    contentUrl:
      'https://smba.trafficmanager.net/de/tenant-id/v3/attachments/attachment-123/views/original',
    name: 'hybridclaw-homepage.png',
  });
});

test('buildTeamsUploadedFileAttachment inlines small images for personal chats', async () => {
  const { buildTeamsUploadedFileAttachment } = await importAttachmentsModule();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-msteams-'));
  tempDirs.push(tempDir);
  const filePath = path.join(tempDir, 'hybridclaw-homepage.png');
  fs.writeFileSync(filePath, Buffer.from([1, 2, 3, 4]));

  const uploadAttachment = vi.fn(async () => ({ id: 'attachment-123' }));
  const connectorKey = Symbol('ConnectorClientKey');
  const turnContext = {
    activity: {
      conversation: {
        id: 'conversation-123',
        conversationType: 'personal',
      },
      serviceUrl: 'https://smba.trafficmanager.net/de/tenant-id/',
    },
    adapter: {
      ConnectorClientKey: connectorKey,
    },
    turnState: new Map([
      [
        connectorKey,
        {
          conversations: {
            uploadAttachment,
          },
        },
      ],
    ]),
  };

  const attachment = await buildTeamsUploadedFileAttachment({
    turnContext: turnContext as never,
    filePath,
    mimeType: 'image/png',
  });

  expect(uploadAttachment).not.toHaveBeenCalled();
  expect(attachment).toEqual({
    contentType: 'image/png',
    contentUrl: `data:image/png;base64,${Buffer.from([1, 2, 3, 4]).toString(
      'base64',
    )}`,
    name: 'hybridclaw-homepage.png',
  });
});

test('buildTeamsAttachmentContext accepts direct Microsoft CDN image attachments', async () => {
  const { buildTeamsAttachmentContext } = await importAttachmentsModule();
  const media = buildTeamsAttachmentContext({
    activity: {
      attachments: [
        {
          contentType: 'image/png',
          contentUrl:
            'https://smba.trafficmanager.net/de/tenant-id/attachments/image.png',
          name: 'image.png',
        },
      ],
    },
  });

  expect(media).toEqual([
    {
      path: null,
      url: 'https://smba.trafficmanager.net/de/tenant-id/attachments/image.png',
      originalUrl:
        'https://smba.trafficmanager.net/de/tenant-id/attachments/image.png',
      mimeType: 'image/png',
      sizeBytes: 0,
      filename: 'image.png',
    },
  ]);
});

test('buildTeamsAttachmentContext extracts Teams file download info attachments', async () => {
  const { buildTeamsAttachmentContext } = await importAttachmentsModule();
  const media = buildTeamsAttachmentContext({
    activity: {
      attachments: [
        {
          contentType: 'application/vnd.microsoft.teams.file.download.info',
          content: {
            downloadUrl:
              'https://contoso.blob.core.windows.net/teams/chat-image.png?sig=test',
            fileName: 'chat-image.png',
            fileType: 'png',
            size: 1234,
          },
          name: 'chat-image.png',
        },
      ],
    },
  });

  expect(media).toEqual([
    {
      path: null,
      url: 'https://contoso.blob.core.windows.net/teams/chat-image.png?sig=test',
      originalUrl:
        'https://contoso.blob.core.windows.net/teams/chat-image.png?sig=test',
      mimeType: 'image/png',
      sizeBytes: 1234,
      filename: 'chat-image.png',
    },
  ]);
});

test('buildTeamsAttachmentContext extracts inline html image urls', async () => {
  const { buildTeamsAttachmentContext } = await importAttachmentsModule();
  const media = buildTeamsAttachmentContext({
    activity: {
      attachments: [
        {
          contentType: 'text/html',
          content:
            '<div><img src="https://asm.skype.com/v1/objects/example/views/imgpsh_fullsize" /></div>',
          name: 'inline-image',
        },
      ],
    },
  });

  expect(media).toEqual([
    {
      path: null,
      url: 'https://asm.skype.com/v1/objects/example/views/imgpsh_fullsize',
      originalUrl:
        'https://asm.skype.com/v1/objects/example/views/imgpsh_fullsize',
      mimeType: 'image/png',
      sizeBytes: 0,
      filename: 'imgpsh_fullsize',
    },
  ]);
});
