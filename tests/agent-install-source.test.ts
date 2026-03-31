import fs from 'node:fs';

import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('resolveInstallArchiveSource downloads direct .claw URLs', async () => {
  const archiveBytes = new Uint8Array([1, 2, 3, 4]);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      expect(input).toBe('https://example.com/downloads/demo.claw');
      return new Response(archiveBytes, { status: 200 });
    }),
  );

  const { resolveInstallArchiveSource } = await import(
    '../src/agents/agent-install-source.js'
  );

  const result = await resolveInstallArchiveSource(
    'https://example.com/downloads/demo.claw',
  );

  expect(result.archivePath).toMatch(/demo\.claw$/);
  expect(fs.readFileSync(result.archivePath)).toEqual(
    Buffer.from(archiveBytes),
  );

  result.cleanup?.();
  expect(fs.existsSync(result.archivePath)).toBe(false);
});

test('isLocalFilesystemInstallSource classifies supported remote sources', async () => {
  const { isLocalFilesystemInstallSource } = await import(
    '../src/agents/agent-install-source.js'
  );

  expect(isLocalFilesystemInstallSource('official:charly')).toBe(false);
  expect(isLocalFilesystemInstallSource('github:owner/repo/charly')).toBe(
    false,
  );
  expect(
    isLocalFilesystemInstallSource('https://example.com/downloads/demo.claw'),
  ).toBe(false);
  expect(isLocalFilesystemInstallSource('./demo.claw')).toBe(true);
});

test('isLocalFilesystemInstallSource does not throw on invalid remote-like sources', async () => {
  const { isLocalFilesystemInstallSource } = await import(
    '../src/agents/agent-install-source.js'
  );

  expect(() =>
    isLocalFilesystemInstallSource('https://example.com/downloads/demo.zip'),
  ).not.toThrow();
  expect(
    isLocalFilesystemInstallSource('https://example.com/downloads/demo.zip'),
  ).toBe(false);

  expect(() => isLocalFilesystemInstallSource('official:')).not.toThrow();
  expect(isLocalFilesystemInstallSource('official:')).toBe(false);

  expect(() =>
    isLocalFilesystemInstallSource('github:owner/repo'),
  ).not.toThrow();
  expect(isLocalFilesystemInstallSource('github:owner/repo')).toBe(false);
});

test('resolveInstallArchiveSource rejects non-.claw URLs with a clear error', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);

  const { resolveInstallArchiveSource } = await import(
    '../src/agents/agent-install-source.js'
  );

  await expect(
    resolveInstallArchiveSource('https://example.com/downloads/demo.zip'),
  ).rejects.toThrow(
    'Install source URL must point to a .claw archive: https://example.com/downloads/demo.zip',
  );
  expect(fetchMock).not.toHaveBeenCalled();
});

test('resolveInstallArchiveSource rejects downloads that exceed the content-length limit', async () => {
  const { CLAW_ARCHIVE_MAX_COMPRESSED_BYTES } = await import(
    '../src/agents/claw-security.js'
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          'content-length': String(CLAW_ARCHIVE_MAX_COMPRESSED_BYTES + 1),
        },
      });
    }),
  );

  const { resolveInstallArchiveSource } = await import(
    '../src/agents/agent-install-source.js'
  );

  await expect(
    resolveInstallArchiveSource('https://example.com/downloads/demo.claw'),
  ).rejects.toThrow(
    `Archive download exceeds the ${CLAW_ARCHIVE_MAX_COMPRESSED_BYTES} byte limit.`,
  );
});

test('resolveInstallArchiveSource rejects streamed downloads that exceed the byte limit', async () => {
  const { CLAW_ARCHIVE_MAX_COMPRESSED_BYTES } = await import(
    '../src/agents/claw-security.js'
  );
  const chunkSize = 2 * 1024 * 1024;
  const chunkCount =
    Math.floor(CLAW_ARCHIVE_MAX_COMPRESSED_BYTES / chunkSize) + 2;
  let emitted = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (emitted >= chunkCount) {
              controller.close();
              return;
            }
            emitted += 1;
            controller.enqueue(new Uint8Array(chunkSize));
          },
        }),
        { status: 200 },
      );
    }),
  );

  const { resolveInstallArchiveSource } = await import(
    '../src/agents/agent-install-source.js'
  );

  await expect(
    resolveInstallArchiveSource('https://example.com/downloads/demo.claw'),
  ).rejects.toThrow(
    `Archive download exceeds the ${CLAW_ARCHIVE_MAX_COMPRESSED_BYTES} byte limit.`,
  );
});
