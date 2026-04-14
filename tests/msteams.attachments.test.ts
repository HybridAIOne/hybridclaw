import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir();

function trackTempDirFromMediaPath(filePath: string | null | undefined): void {
  if (!filePath) return;
  makeTempDir.track(path.dirname(filePath));
}

async function importAttachmentsModule(
  configOverrides: Record<string, unknown> = {},
) {
  vi.resetModules();
  const dataDir = makeTempDir('hybridclaw-msteams-cache-');
  const baseConfig = {
    CONTAINER_SANDBOX_MODE: 'host',
    DATA_DIR: dataDir,
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
  };
  vi.doMock('../src/config/config.js', () => ({
    ...baseConfig,
    ...configOverrides,
  }));
  return import('../src/channels/msteams/attachments.js');
}

useCleanMocks({
  restoreAllMocks: true,
  resetModules: true,
  unstubAllGlobals: true,
});

test('buildTeamsUploadedFileAttachment uploads the file through Bot Framework', async () => {
  const { buildTeamsUploadedFileAttachment } = await importAttachmentsModule();
  const tempDir = makeTempDir('hybridclaw-msteams-');
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
  const tempDir = makeTempDir('hybridclaw-msteams-');
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

test('buildTeamsUploadedFileAttachment still inlines tall personal images under 4 MB', async () => {
  const { buildTeamsUploadedFileAttachment } = await importAttachmentsModule();
  const tempDir = makeTempDir('hybridclaw-msteams-');
  const filePath = path.join(tempDir, 'hybridclaw-homepage.png');
  const fileBuffer = Buffer.alloc(2_000_000, 1);
  fs.writeFileSync(filePath, fileBuffer);

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
    contentUrl: `data:image/png;base64,${fileBuffer.toString('base64')}`,
    name: 'hybridclaw-homepage.png',
  });
});

test('buildTeamsUploadedFileAttachment uses a file consent card for personal non-image files', async () => {
  const { buildTeamsUploadedFileAttachment } = await importAttachmentsModule();
  const tempDir = makeTempDir('hybridclaw-msteams-');
  const filePath = path.join(tempDir, 'report.pdf');
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
    mimeType: 'application/pdf',
  });

  expect(uploadAttachment).not.toHaveBeenCalled();
  expect(attachment).toMatchObject({
    contentType: 'application/vnd.microsoft.teams.card.file.consent',
    name: 'report.pdf',
    content: expect.objectContaining({
      sizeInBytes: 4,
      acceptContext: expect.objectContaining({
        filename: 'report.pdf',
        uploadId: expect.any(String),
      }),
      declineContext: expect.objectContaining({
        filename: 'report.pdf',
        uploadId: expect.any(String),
      }),
    }),
  });
});

test('buildTeamsUploadedFileAttachment rejects large non-personal uploads without a storage fallback', async () => {
  const { buildTeamsUploadedFileAttachment } = await importAttachmentsModule();
  const tempDir = makeTempDir('hybridclaw-msteams-');
  const filePath = path.join(tempDir, 'large.zip');
  fs.writeFileSync(filePath, Buffer.alloc(4_300_000, 1));

  const connectorKey = Symbol('ConnectorClientKey');
  const turnContext = {
    activity: {
      conversation: {
        id: 'conversation-123',
        conversationType: 'groupChat',
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
            uploadAttachment: vi.fn(async () => ({ id: 'attachment-123' })),
          },
        },
      ],
    ]),
  };

  await expect(
    buildTeamsUploadedFileAttachment({
      turnContext: turnContext as never,
      filePath,
      mimeType: 'application/zip',
    }),
  ).rejects.toThrow(
    'Teams file uploads larger than 4 MB in channels or group chats require SharePoint/OneDrive fallback, which is not implemented yet.',
  );
});

test('maybeHandleMSTeamsFileConsentInvoke uploads the pending file and sends a file info card', async () => {
  const {
    buildTeamsUploadedFileAttachment,
    maybeHandleMSTeamsFileConsentInvoke,
  } = await importAttachmentsModule();
  const tempDir = makeTempDir('hybridclaw-msteams-');
  const filePath = path.join(tempDir, 'report.pdf');
  fs.writeFileSync(filePath, Buffer.from([1, 2, 3, 4]));

  const connectorKey = Symbol('ConnectorClientKey');
  const seedTurnContext = {
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
            uploadAttachment: vi.fn(async () => ({ id: 'attachment-123' })),
          },
        },
      ],
    ]),
  };

  const consentCard = await buildTeamsUploadedFileAttachment({
    turnContext: seedTurnContext as never,
    filePath,
    mimeType: 'application/pdf',
  });
  const uploadId = String(
    (consentCard as { content?: { acceptContext?: { uploadId?: string } } })
      .content?.acceptContext?.uploadId || '',
  );

  const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  const sendActivity = vi.fn(async () => ({ id: 'reply-1' }));
  const handled = await maybeHandleMSTeamsFileConsentInvoke({
    activity: {
      type: 'invoke',
      name: 'fileConsent/invoke',
      conversation: { id: 'conversation-123' },
      value: {
        type: 'fileUpload',
        action: 'accept',
        context: {
          uploadId,
        },
        uploadInfo: {
          uploadUrl: 'https://upload.example.com/file',
          contentUrl: 'https://download.example.com/file',
          uniqueId: 'unique-file-id',
          fileType: 'pdf',
          name: 'report.pdf',
        },
      },
    },
    sendActivity,
  } as never);

  expect(handled).toBe(true);
  expect(fetchMock).toHaveBeenCalledWith(
    'https://upload.example.com/file',
    expect.objectContaining({
      method: 'PUT',
      headers: expect.objectContaining({
        'content-range': 'bytes 0-3/4',
        'content-type': 'application/pdf',
      }),
      signal: expect.any(AbortSignal),
    }),
  );
  expect(sendActivity).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({
      type: 'invokeResponse',
      value: { status: 200 },
    }),
  );
  expect(sendActivity).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      type: 'message',
      attachments: [
        expect.objectContaining({
          contentType: 'application/vnd.microsoft.teams.card.file.info',
          contentUrl: 'https://download.example.com/file',
          name: 'report.pdf',
        }),
      ],
    }),
  );
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
  expect(media[0]?.path || '').toContain('uploaded-media-cache');
  expect(fs.readFileSync(media[0]?.path || '')).toEqual(Buffer.from([1, 2, 3]));
});

test('buildTeamsAttachmentContext uses attachment content tokens for direct Teams contentUrl images', async () => {
  const { buildTeamsAttachmentContext } = await importAttachmentsModule({
    MSTEAMS_MEDIA_ALLOW_HOSTS: ['graph.microsoft.com'],
    MSTEAMS_MEDIA_AUTH_ALLOW_HOSTS: ['graph.microsoft.com'],
  });
  const fetchMock = vi.fn(
    async (_url: string, init?: RequestInit) =>
      new Response(Buffer.from([24, 25, 26]), {
        status: 200,
        headers: {
          'content-length': '3',
          'content-type': 'image/png',
          'x-auth-header':
            typeof init?.headers === 'object' &&
            init.headers &&
            'Authorization' in init.headers
              ? String(
                  (init.headers as Record<string, string>).Authorization || '',
                )
              : '',
        },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);

  const media = await buildTeamsAttachmentContext({
    activity: {
      attachments: [
        {
          contentType: 'image/*',
          contentUrl:
            'https://smba.trafficmanager.net/de/tenant-id/v3/attachments/example/views/original',
          content: {
            token: 'attachment-token',
          },
          name: 'teams-upload.png',
        },
      ],
    },
  });
  trackTempDirFromMediaPath(media[0]?.path);

  expect(fetchMock).toHaveBeenCalledOnce();
  expect(fetchMock).toHaveBeenCalledWith(
    'https://smba.trafficmanager.net/de/tenant-id/v3/attachments/example/views/original',
    expect.objectContaining({
      headers: expect.objectContaining({
        Accept: '*/*',
        Authorization: 'Bearer attachment-token',
      }),
    }),
  );
  expect(media).toHaveLength(1);
  expect(media[0]).toEqual({
    path: expect.any(String),
    url: 'https://smba.trafficmanager.net/de/tenant-id/v3/attachments/example/views/original',
    originalUrl:
      'https://smba.trafficmanager.net/de/tenant-id/v3/attachments/example/views/original',
    mimeType: 'image/png',
    sizeBytes: 3,
    filename: 'teams-upload.png',
  });
  expect(fs.readFileSync(media[0]?.path || '')).toEqual(
    Buffer.from([24, 25, 26]),
  );
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
    filename: 'inline-image',
  });
  expect(fs.readFileSync(media[0]?.path || '')).toEqual(Buffer.from([8, 9]));
});

test('buildTeamsAttachmentContext stages supported data url images locally', async () => {
  const { buildTeamsAttachmentContext } = await importAttachmentsModule({
    MSTEAMS_MEDIA_MAX_MB: 1,
  });

  const media = await buildTeamsAttachmentContext({
    activity: {
      attachments: [
        {
          contentType: 'image/png',
          contentUrl: `data:image/png;base64,${Buffer.from([1, 2, 3]).toString(
            'base64',
          )}`,
          name: 'inline-image.png',
        },
      ],
    },
  });
  trackTempDirFromMediaPath(media[0]?.path);

  expect(media).toHaveLength(1);
  expect(media[0]).toEqual({
    path: expect.any(String),
    url: expect.stringContaining('data:image/png;base64,'),
    originalUrl: expect.stringContaining('data:image/png;base64,'),
    mimeType: 'image/png',
    sizeBytes: 3,
    filename: 'inline-image.png',
  });
  expect(fs.readFileSync(media[0]?.path || '')).toEqual(Buffer.from([1, 2, 3]));
});

test('buildTeamsAttachmentContext rejects oversized data url images before writing them to disk', async () => {
  const { buildTeamsAttachmentContext } = await importAttachmentsModule({
    MSTEAMS_MEDIA_MAX_MB: 1,
  });
  const writeFileSpy = vi.spyOn(fsPromises, 'writeFile');
  const oversizedBuffer = Buffer.alloc(1_048_577, 1);

  const media = await buildTeamsAttachmentContext({
    activity: {
      attachments: [
        {
          contentType: 'image/png',
          contentUrl: `data:image/png;base64,${oversizedBuffer.toString(
            'base64',
          )}`,
          name: 'too-large-inline-image.png',
        },
      ],
    },
  });

  expect(media).toEqual([]);
  expect(writeFileSpy).not.toHaveBeenCalled();
});

test('buildTeamsAttachmentContext retries Teams media downloads with auth for Teams hosts', async () => {
  const { buildTeamsAttachmentContext } = await importAttachmentsModule({
    MSTEAMS_MEDIA_ALLOW_HOSTS: ['*.teams.microsoft.com'],
    MSTEAMS_MEDIA_AUTH_ALLOW_HOSTS: ['graph.microsoft.com'],
  });
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
      signal: expect.any(AbortSignal),
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
      signal: expect.any(AbortSignal),
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
    filename: 'teams-image.png',
  });
  expect(fs.readFileSync(media[0]?.path || '')).toEqual(
    Buffer.from([10, 11, 12]),
  );
});

test('buildTeamsAttachmentContext evicts stale OAuth tokens before requesting a fresh one', async () => {
  vi.useFakeTimers();
  try {
    const { buildTeamsAttachmentContext } = await importAttachmentsModule({
      MSTEAMS_MEDIA_ALLOW_HOSTS: ['*.teams.microsoft.com'],
      MSTEAMS_MEDIA_AUTH_ALLOW_HOSTS: ['graph.microsoft.com'],
    });
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
            access_token: 'teams-access-token-1',
            expires_in: 120,
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
        new Response(Buffer.from([1, 2, 3]), {
          status: 200,
          headers: {
            'content-length': '3',
            'content-type': 'image/png',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response('', {
          status: 403,
          statusText: 'Forbidden',
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'teams-access-token-2',
            expires_in: 120,
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
        new Response(Buffer.from([4, 5, 6]), {
          status: 200,
          headers: {
            'content-length': '3',
            'content-type': 'image/png',
          },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const activity = {
      attachments: [
        {
          contentType: 'image/png',
          contentUrl:
            'https://de-prod.asyncgw.teams.microsoft.com/v1/objects/example/views/imgpsh_fullsize',
          name: 'teams-image.png',
        },
      ],
    };

    const firstMedia = await buildTeamsAttachmentContext({ activity });
    trackTempDirFromMediaPath(firstMedia[0]?.path);

    await vi.advanceTimersByTimeAsync(61_000);

    const secondMedia = await buildTeamsAttachmentContext({ activity });
    trackTempDirFromMediaPath(secondMedia[0]?.path);

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://login.microsoftonline.com/teams-tenant-id/oauth2/v2.0/token',
      expect.objectContaining({
        body: expect.stringContaining(
          'scope=https%3A%2F%2Fapi.botframework.com%2F.default',
        ),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      'https://login.microsoftonline.com/teams-tenant-id/oauth2/v2.0/token',
      expect.objectContaining({
        body: expect.stringContaining(
          'scope=https%3A%2F%2Fapi.botframework.com%2F.default',
        ),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      6,
      'https://de-prod.asyncgw.teams.microsoft.com/v1/objects/example/views/imgpsh_fullsize',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer teams-access-token-2',
        }),
      }),
    );
  } finally {
    vi.useRealTimers();
  }
});

test('buildTeamsAttachmentContext retries Bot Framework attachment downloads with auth for trafficmanager hosts', async () => {
  const { buildTeamsAttachmentContext } = await importAttachmentsModule({
    MSTEAMS_MEDIA_ALLOW_HOSTS: ['graph.microsoft.com'],
    MSTEAMS_MEDIA_AUTH_ALLOW_HOSTS: ['graph.microsoft.com'],
  });
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response('', {
        status: 401,
        statusText: 'Unauthorized',
      }),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'botframework-access-token',
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
      new Response(Buffer.from([21, 22, 23]), {
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
          contentType: 'image/*',
          contentUrl:
            'https://smba.trafficmanager.net/de/tenant-id/v3/attachments/attachment-123/views/original',
          name: 'original',
        },
      ],
    },
  });
  trackTempDirFromMediaPath(media[0]?.path);

  expect(fetchMock).toHaveBeenNthCalledWith(
    1,
    'https://smba.trafficmanager.net/de/tenant-id/v3/attachments/attachment-123/views/original',
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
      signal: expect.any(AbortSignal),
    }),
  );
  expect(fetchMock).toHaveBeenNthCalledWith(
    3,
    'https://smba.trafficmanager.net/de/tenant-id/v3/attachments/attachment-123/views/original',
    expect.objectContaining({
      headers: expect.objectContaining({
        Accept: '*/*',
        Authorization: 'Bearer botframework-access-token',
      }),
      signal: expect.any(AbortSignal),
    }),
  );
  expect(media).toHaveLength(1);
  expect(media[0]).toEqual({
    path: expect.any(String),
    url: 'https://smba.trafficmanager.net/de/tenant-id/v3/attachments/attachment-123/views/original',
    originalUrl:
      'https://smba.trafficmanager.net/de/tenant-id/v3/attachments/attachment-123/views/original',
    mimeType: 'image/png',
    sizeBytes: 3,
    filename: 'original',
  });
  expect(fs.readFileSync(media[0]?.path || '')).toEqual(
    Buffer.from([21, 22, 23]),
  );
});

test('buildTeamsAttachmentContext sniffs image uploads when Teams returns application/octet-stream', async () => {
  const { buildTeamsAttachmentContext } = await importAttachmentsModule({
    MSTEAMS_MEDIA_ALLOW_HOSTS: ['graph.microsoft.com'],
    MSTEAMS_MEDIA_AUTH_ALLOW_HOSTS: ['graph.microsoft.com'],
  });
  const pngBuffer = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03,
  ]);
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response('', {
        status: 401,
        statusText: 'Unauthorized',
      }),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'botframework-access-token',
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
      new Response(pngBuffer, {
        status: 200,
        headers: {
          'content-length': String(pngBuffer.length),
          'content-type': 'application/octet-stream',
        },
      }),
    );
  vi.stubGlobal('fetch', fetchMock);

  const media = await buildTeamsAttachmentContext({
    activity: {
      attachments: [
        {
          contentType: 'application/octet-stream',
          contentUrl:
            'https://smba.trafficmanager.net/de/tenant-id/v3/attachments/attachment-456/views/original',
          name: 'original',
        },
      ],
    },
  });
  trackTempDirFromMediaPath(media[0]?.path);

  expect(media).toHaveLength(1);
  expect(media[0]).toEqual({
    path: expect.any(String),
    url: 'https://smba.trafficmanager.net/de/tenant-id/v3/attachments/attachment-456/views/original',
    originalUrl:
      'https://smba.trafficmanager.net/de/tenant-id/v3/attachments/attachment-456/views/original',
    mimeType: 'image/png',
    sizeBytes: pngBuffer.length,
    filename: 'original',
  });
  expect(media[0]?.path || '').toContain('uploaded-media-cache');
  expect(path.basename(media[0]?.path || '')).toMatch(/-original\.png$/);
  expect(fs.readFileSync(media[0]?.path || '')).toEqual(pngBuffer);
});

test('buildTeamsAttachmentContext extracts Teams image attachments from content.downloadUrl', async () => {
  const { buildTeamsAttachmentContext } = await importAttachmentsModule({
    MSTEAMS_MEDIA_ALLOW_HOSTS: ['graph.microsoft.com'],
    MSTEAMS_MEDIA_AUTH_ALLOW_HOSTS: ['graph.microsoft.com'],
  });
  const fetchMock = vi.fn(
    async (_url: string, init?: RequestInit) =>
      new Response(Buffer.from([13, 14, 15]), {
        status: 200,
        headers: {
          'content-length': '3',
          'content-type': 'image/png',
          'x-auth-header':
            typeof init?.headers === 'object' &&
            init.headers &&
            'Authorization' in init.headers
              ? String(
                  (init.headers as Record<string, string>).Authorization || '',
                )
              : '',
        },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);

  const media = await buildTeamsAttachmentContext({
    activity: {
      attachments: [
        {
          contentType: 'image/*',
          content: {
            downloadUrl:
              'https://de-prod.asyncgw.teams.microsoft.com/v1/objects/example/views/imgo',
            fileName: 'teams-upload.png',
            fileType: 'png',
            token: 'attachment-token',
          },
          name: 'teams-upload',
        },
        {
          contentType: 'text/html',
          content:
            '<div><img src="https://de-prod.asyncgw.teams.microsoft.com/v1/objects/example/views/imgo" /></div>',
          name: 'html-fallback',
        },
      ],
    },
  });
  trackTempDirFromMediaPath(media[0]?.path);

  expect(fetchMock).toHaveBeenCalledOnce();
  expect(fetchMock).toHaveBeenCalledWith(
    'https://de-prod.asyncgw.teams.microsoft.com/v1/objects/example/views/imgo',
    expect.objectContaining({
      headers: expect.objectContaining({
        Accept: '*/*',
        Authorization: 'Bearer attachment-token',
      }),
    }),
  );
  expect(media).toHaveLength(1);
  expect(media[0]).toEqual({
    path: expect.any(String),
    url: 'https://de-prod.asyncgw.teams.microsoft.com/v1/objects/example/views/imgo',
    originalUrl:
      'https://de-prod.asyncgw.teams.microsoft.com/v1/objects/example/views/imgo',
    mimeType: 'image/png',
    sizeBytes: 3,
    filename: 'teams-upload.png',
  });
  expect(fs.readFileSync(media[0]?.path || '')).toEqual(
    Buffer.from([13, 14, 15]),
  );
});

test('buildTeamsAttachmentContext preserves Unicode filenames when staging media', async () => {
  const { buildTeamsAttachmentContext } = await importAttachmentsModule();
  const fetchMock = vi.fn(
    async () =>
      new Response(Buffer.from([31, 32, 33]), {
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
          name: 'Überblick_日本語.png',
        },
      ],
    },
  });
  trackTempDirFromMediaPath(media[0]?.path);

  expect(media).toHaveLength(1);
  expect(media[0]?.filename).toBe('Überblick_日本語.png');
  expect(media[0]?.path || '').toContain('uploaded-media-cache');
  expect(path.basename(media[0]?.path || '')).toMatch(
    /-Überblick_日本語\.png$/,
  );
});
