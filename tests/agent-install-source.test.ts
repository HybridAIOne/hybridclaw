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
