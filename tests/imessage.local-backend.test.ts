import { afterEach, describe, expect, test, vi } from 'vitest';

async function importFreshLocalBackend(options?: {
  execFileError?: NodeJS.ErrnoException | null;
  rows?: Array<Record<string, unknown>>;
  initialRowId?: number;
}) {
  vi.resetModules();
  const warn = vi.fn();
  vi.doMock('node:child_process', () => ({
    execFile: vi.fn((_file, _args, _opts, callback) => {
      callback(
        options?.execFileError ||
          Object.assign(new Error('spawn imsg ENOENT'), {
            code: 'ENOENT',
          }),
      );
    }),
  }));
  const prepare = vi.fn((sql: string) => {
    if (sql.includes('COALESCE(MAX(ROWID), 0)')) {
      return {
        get: vi.fn(() => ({ rowid: options?.initialRowId ?? 0 })),
      };
    }
    return {
      all: vi.fn(() => options?.rows || []),
    };
  });
  const close = vi.fn();
  const DatabaseMock = vi.fn(function DatabaseMock() {
    return {
      prepare,
      close,
    };
  });
  vi.doMock('better-sqlite3', () => ({
    default: DatabaseMock,
  }));
  vi.doMock('../src/config/config.js', () => ({
    IMESSAGE_CLI_PATH: 'imsg',
    IMESSAGE_DB_PATH: '/tmp/chat.db',
    IMESSAGE_POLL_INTERVAL_MS: 2500,
    IMESSAGE_TEXT_CHUNK_LIMIT: 4000,
    getConfigSnapshot: vi.fn(() => ({
      imessage: {
        enabled: true,
        backend: 'local',
        cliPath: 'imsg',
        dbPath: '/tmp/chat.db',
        pollIntervalMs: 2500,
        serverUrl: '',
        password: '',
        webhookPath: '/api/imessage/webhook',
        allowPrivateNetwork: false,
        dmPolicy: 'open',
        groupPolicy: 'disabled',
        allowFrom: [],
        groupAllowFrom: [],
        textChunkLimit: 4000,
        debounceMs: 2500,
        mediaMaxMb: 20,
      },
    })),
  }));
  vi.doMock('../src/logger.js', () => ({
    logger: {
      warn,
    },
  }));
  vi.doMock('../src/channels/imessage/local-prereqs.js', () => ({
    assertLocalIMessageBackendReady: vi.fn(),
    formatMissingIMessageCliMessage: vi.fn(
      (cliPath: string) =>
        `Missing iMessage CLI binary: ${cliPath}. Install it with \`brew install steipete/tap/imsg\` or rerun \`hybridclaw channels imessage setup --cli-path /absolute/path/to/imsg ...\`.`,
    ),
  }));
  const module = await import('../src/channels/imessage/backend-local.js');
  return {
    ...module,
    DatabaseMock,
    prepare,
    close,
    warn,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.doUnmock('node:child_process');
  vi.doUnmock('better-sqlite3');
  vi.doUnmock('../src/config/config.js');
  vi.doUnmock('../src/logger.js');
  vi.doUnmock('../src/channels/imessage/local-prereqs.js');
});

describe('local iMessage backend', () => {
  test('surfaces a clear install hint when the imsg binary is missing', async () => {
    const { createLocalIMessageBackend } = await importFreshLocalBackend();
    const backend = createLocalIMessageBackend({
      onInbound: vi.fn(async () => {}),
    });

    await expect(
      backend.sendText('imessage:+14155551212', 'hello'),
    ).rejects.toThrow(
      /Missing iMessage CLI binary: imsg\. Install it with `brew install steipete\/tap\/imsg`/,
    );
  });

  test('passes local self-chat rows through to runtime handling', async () => {
    vi.useFakeTimers();
    const { createLocalIMessageBackend } = await importFreshLocalBackend({
      rows: [
        {
          rowid: 1,
          messageGuid: null,
          messageDate: 123456789,
          text: 'Hi',
          attributedBody: null,
          isFromMe: 1,
          handle: '+14155551212',
          chatGuid: null,
          chatIdentifier: '+14155551212',
          chatDisplayName: null,
        },
      ],
    });
    const onInbound = vi.fn(async () => {});
    const backend = createLocalIMessageBackend({ onInbound });

    await backend.start();
    await vi.advanceTimersByTimeAsync(2500);

    expect(onInbound).toHaveBeenCalledTimes(1);
    expect(onInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'imessage:+14155551212',
        content: 'Hi',
        handle: '+14155551212',
        backend: 'local',
      }),
    );
    await backend.shutdown();
  });

  test('decodes supported attributedBody-only rows', async () => {
    vi.useFakeTimers();
    const { createLocalIMessageBackend, warn } = await importFreshLocalBackend({
      rows: [
        {
          rowid: 2,
          messageGuid: null,
          messageDate: 123456790,
          text: null,
          attributedBody: Buffer.from(
            'prefix NSString /status \u0002iI\u0001NSDictionary trailing',
            'utf8',
          ),
          isFromMe: 0,
          handle: '+14155551212',
          chatGuid: null,
          chatIdentifier: '+14155551212',
          chatDisplayName: null,
        },
      ],
    });
    const onInbound = vi.fn(async () => {});
    const backend = createLocalIMessageBackend({ onInbound });

    await backend.start();
    await vi.advanceTimersByTimeAsync(2500);

    expect(onInbound).toHaveBeenCalledTimes(1);
    expect(onInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        content: '/status',
      }),
    );
    expect(warn).not.toHaveBeenCalled();
    await backend.shutdown();
  });

  test('skips unsupported attributedBody-only rows and logs a warning', async () => {
    vi.useFakeTimers();
    const { createLocalIMessageBackend, warn } = await importFreshLocalBackend({
      rows: [
        {
          rowid: 22,
          messageGuid: null,
          messageDate: 123456790,
          text: null,
          attributedBody: Buffer.from([0x01, 0x02, 0x03, 0x04]),
          isFromMe: 0,
          handle: '+14155551212',
          chatGuid: null,
          chatIdentifier: '+14155551212',
          chatDisplayName: null,
        },
      ],
    });
    const onInbound = vi.fn(async () => {});
    const backend = createLocalIMessageBackend({ onInbound });

    await backend.start();
    await vi.advanceTimersByTimeAsync(2500);

    expect(onInbound).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        rowid: 22,
        attributedBodyBytes: 4,
      }),
      'Skipping local iMessage row without plain text; attributedBody decoding is not supported',
    );
    await backend.shutdown();
  });

  test('normalizes local self-chat slash commands that arrive with a leading marker character', async () => {
    vi.useFakeTimers();
    const { createLocalIMessageBackend } = await importFreshLocalBackend({
      rows: [
        {
          rowid: 3,
          messageGuid: null,
          messageDate: 123456791,
          text: '+ /status',
          attributedBody: null,
          isFromMe: 1,
          handle: '+14155551212',
          chatGuid: null,
          chatIdentifier: '+14155551212',
          chatDisplayName: null,
        },
      ],
    });
    const onInbound = vi.fn(async () => {});
    const backend = createLocalIMessageBackend({ onInbound });

    await backend.start();
    await vi.advanceTimersByTimeAsync(2500);

    expect(onInbound).toHaveBeenCalledTimes(1);
    expect(onInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        content: '/status',
      }),
    );
    await backend.shutdown();
  });

  test('prepares the local poll query once and reuses it across poll cycles', async () => {
    vi.useFakeTimers();
    const { createLocalIMessageBackend, prepare } =
      await importFreshLocalBackend({
        rows: [],
      });
    const onInbound = vi.fn(async () => {});
    const backend = createLocalIMessageBackend({ onInbound });

    await backend.start();
    await vi.advanceTimersByTimeAsync(2500);
    await vi.advanceTimersByTimeAsync(2500);

    expect(
      prepare.mock.calls.filter(
        ([sql]) =>
          typeof sql === 'string' &&
          sql.includes('FROM message m') &&
          sql.includes('LIMIT 200'),
      ),
    ).toHaveLength(1);
    await backend.shutdown();
  });
});
