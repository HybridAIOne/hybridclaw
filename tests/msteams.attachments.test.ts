import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

const tempDirs: string[] = [];

function trackTempDirFromMediaPath(filePath: string | null | undefined): void {
  if (!filePath) return;
  tempDirs.push(path.dirname(filePath));
}

async function importAttachmentsModule() {
  vi.resetModules();
  vi.doMock('../src/config/config.js', () => ({
    MSTEAMS_APP_ID: 'teams-app-id',
    MSTEAMS_APP_PASSWORD: 'teams-secret',
    MSTEAMS_MEDIA_ALLOW_HOSTS: [
      '*.teams.microsoft.com',
      '*.trafficmanager.net',
      '*.blob.core.windows.net',
      'asm.skype.com',
    ],
    MSTEAMS_MEDIA_AUTH_ALLOW_HOSTS: [
      'graph.microsoft.com',
      '*.teams.microsoft.com',
    ],
    MSTEAMS_MEDIA_MAX_MB: 20,
    MSTEAMS_TENANT_ID: 'teams-tenant-id',
  }));
  return import('../src/channels/msteams/attachments.js');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unmock('@napi-rs/canvas');
  vi.unstubAllGlobals();
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
  vi.doMock('@napi-rs/canvas', () => ({
    loadImage: vi.fn(async () => ({
      height: 512,
      width: 512,
    })),
  }));
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

test('buildTeamsUploadedFileAttachment uploads oversized personal images instead of inlining them', async () => {
  vi.doMock('@napi-rs/canvas', () => ({
    loadImage: vi.fn(async () => ({
      height: 14_323,
      width: 1_280,
    })),
  }));
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

  expect(uploadAttachment).toHaveBeenCalledOnce();
  expect(attachment).toEqual({
    contentType: 'image/png',
    contentUrl:
      'https://smba.trafficmanager.net/de/tenant-id/v3/attachments/attachment-123/views/original',
    name: 'hybridclaw-homepage.png',
  });
});

test('buildTeamsAttachmentContext accepts direct Microsoft CDN image attachments', async () => {
  const { buildTeamsAttachmentContext } = await importAttachmentsModule();
  const fetchMock = vi.fn(
    async () =>
      new Response(Buffer.from([1, 2, 3]), {
        status: 200,
        headers: {
          'content-length': '3',
          'content-type': 'image/png',
        },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);

  const media = await buildTeamsAttachmentContext({
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
  trackTempDirFromMediaPath(media[0]?.path);

  expect(fetchMock).toHaveBeenCalledWith(
    'https://smba.trafficmanager.net/de/tenant-id/attachments/image.png',
    expect.objectContaining({
      headers: {
        Accept: '*/*',
      },
    }),
  );
  expect(media).toHaveLength(1);
  expect(media[0]).toEqual({
    path: expect.any(String),
    url: 'https://smba.trafficmanager.net/de/tenant-id/attachments/image.png',
    originalUrl:
      'https://smba.trafficmanager.net/de/tenant-id/attachments/image.png',
    mimeType: 'image/png',
    sizeBytes: 3,
    filename: 'image.png',
  });
  expect(fs.readFileSync(media[0]?.path || '')).toEqual(Buffer.from([1, 2, 3]));
});

test('buildTeamsAttachmentContext extracts Teams file download info attachments', async () => {
  const { buildTeamsAttachmentContext } = await importAttachmentsModule();
  const fetchMock = vi.fn(
    async () =>
      new Response(Buffer.from([4, 5, 6, 7]), {
        status: 200,
        headers: {
          'content-length': '4',
          'content-type': 'image/png',
        },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);

  const media = await buildTeamsAttachmentContext({
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
  trackTempDirFromMediaPath(media[0]?.path);

  expect(media).toHaveLength(1);
  expect(media[0]).toEqual({
    path: expect.any(String),
    url: 'https://contoso.blob.core.windows.net/teams/chat-image.png?sig=test',
    originalUrl:
      'https://contoso.blob.core.windows.net/teams/chat-image.png?sig=test',
    mimeType: 'image/png',
    sizeBytes: 4,
    filename: 'chat-image.png',
  });
  expect(fs.readFileSync(media[0]?.path || '')).toEqual(
    Buffer.from([4, 5, 6, 7]),
  );
});

test('buildTeamsAttachmentContext extracts inline html image urls', async () => {
  const { buildTeamsAttachmentContext } = await importAttachmentsModule();
  const fetchMock = vi.fn(
    async () =>
      new Response(Buffer.from([8, 9]), {
        status: 200,
        headers: {
          'content-length': '2',
          'content-type': 'image/png',
        },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);

  const media = await buildTeamsAttachmentContext({
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
  trackTempDirFromMediaPath(media[0]?.path);

  expect(media).toHaveLength(1);
  expect(media[0]).toEqual({
    path: expect.any(String),
    url: 'https://asm.skype.com/v1/objects/example/views/imgpsh_fullsize',
    originalUrl:
      'https://asm.skype.com/v1/objects/example/views/imgpsh_fullsize',
    mimeType: 'image/png',
    sizeBytes: 2,
    filename: 'imgpsh_fullsize',
  });
  expect(fs.readFileSync(media[0]?.path || '')).toEqual(Buffer.from([8, 9]));
});

test('buildTeamsAttachmentContext retries Teams media downloads with auth for Teams hosts', async () => {
  const { buildTeamsAttachmentContext } = await importAttachmentsModule();
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response('', {
        status: 403,
        statusText: 'Forbidden',
      }),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'teams-access-token',
          expires_in: 3600,
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      ),
    )
    .mockResolvedValueOnce(
      new Response(Buffer.from([10, 11, 12]), {
        status: 200,
        headers: {
          'content-length': '3',
          'content-type': 'image/png',
        },
      }),
    );
  vi.stubGlobal('fetch', fetchMock);

  const media = await buildTeamsAttachmentContext({
    activity: {
      attachments: [
        {
          contentType: 'image/png',
          contentUrl:
            'https://de-prod.asyncgw.teams.microsoft.com/v1/objects/example/views/imgpsh_fullsize',
          name: 'teams-image.png',
        },
      ],
    },
  });
  trackTempDirFromMediaPath(media[0]?.path);

  expect(fetchMock).toHaveBeenNthCalledWith(
    1,
    'https://de-prod.asyncgw.teams.microsoft.com/v1/objects/example/views/imgpsh_fullsize',
    expect.objectContaining({
      headers: {
        Accept: '*/*',
      },
    }),
  );
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    'https://login.microsoftonline.com/teams-tenant-id/oauth2/v2.0/token',
    expect.objectContaining({
      body: expect.stringContaining(
        'scope=https%3A%2F%2Fapi.botframework.com%2F.default',
      ),
      method: 'POST',
    }),
  );
  expect(fetchMock).toHaveBeenNthCalledWith(
    3,
    'https://de-prod.asyncgw.teams.microsoft.com/v1/objects/example/views/imgpsh_fullsize',
    expect.objectContaining({
      headers: expect.objectContaining({
        Accept: '*/*',
        Authorization: 'Bearer teams-access-token',
      }),
    }),
  );
  expect(media).toHaveLength(1);
  expect(media[0]).toEqual({
    path: expect.any(String),
    url: 'https://de-prod.asyncgw.teams.microsoft.com/v1/objects/example/views/imgpsh_fullsize',
    originalUrl:
      'https://de-prod.asyncgw.teams.microsoft.com/v1/objects/example/views/imgpsh_fullsize',
    mimeType: 'image/png',
    sizeBytes: 3,
    filename: 'imgpsh_fullsize',
  });
  expect(fs.readFileSync(media[0]?.path || '')).toEqual(
    Buffer.from([10, 11, 12]),
  );
});
