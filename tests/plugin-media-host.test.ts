import fs from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, test, vi } from 'vitest';

import { useCleanMocks, useTempDir } from './test-utils.ts';

const { fetchPublicHttpsBufferMock } = vi.hoisted(() => ({
  fetchPublicHttpsBufferMock: vi.fn(),
}));

vi.mock('../src/memory/db.js', () => ({
  getSessionById: vi.fn(() => undefined),
}));

vi.mock('../src/providers/factory.js', () => ({
  resolveModelRuntimeCredentials: vi.fn(async () => ({
    provider: 'hybridai',
    model: 'test-model',
    baseUrl: 'https://example.com',
    apiKey: 'test-key',
    requestHeaders: {},
  })),
}));

vi.mock('../src/security/public-https-fetch.js', () => ({
  fetchPublicHttpsBuffer: fetchPublicHttpsBufferMock,
}));

const makeTempDir = useTempDir('hybridclaw-plugin-media-host-');
useCleanMocks({ unstubAllEnvs: true, resetModules: true });

let workspaceRoot = '';

async function loadHost() {
  // Point HOME at a temp dir before runtime-config loads, so the test never
  // reads or migrates the developer's real ~/.hybridclaw/config.json.
  const home = makeTempDir();
  vi.stubEnv('HOME', home);
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', path.join(home, '.hybridclaw'));
  vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
  vi.resetModules();
  const { createPluginMediaHost } = await import(
    '../src/plugins/plugin-media-host.js'
  );
  return createPluginMediaHost({
    resolveAgentId: () => 'main',
    resolveWorkspaceRoot: () => workspaceRoot,
  });
}

beforeEach(() => {
  workspaceRoot = makeTempDir();
  fetchPublicHttpsBufferMock.mockReset();
});

describe('createPluginMediaHost', () => {
  test('resolves an existing /workspace file to the host path', async () => {
    const host = await loadHost();
    const hostFile = path.join(workspaceRoot, 'clip.wav');
    fs.writeFileSync(hostFile, 'fake-wav');

    await expect(
      host.resolveInputPath('session-1', '/workspace/clip.wav', []),
    ).resolves.toBe(fs.realpathSync(hostFile));
  });

  test.each([
    ['a Discord media-cache path outside the current media', '/discord-media-cache/1/clip.wav'],
    ['a path outside the allowed roots', '/etc/hosts'],
    ['a workspace path that escapes the root', '/workspace/../../etc/hosts'],
    ['an empty path', '   '],
  ])('returns null for %s', async (_label, rawPath) => {
    const host = await loadHost();

    await expect(
      host.resolveInputPath('session-1', rawPath, [
        {
          path: '/discord-media-cache/2/other.wav',
          url: '',
          originalUrl: '',
          mimeType: 'audio/wav',
          sizeBytes: 1,
          filename: 'other.wav',
        },
      ]),
    ).resolves.toBeNull();
  });

  test('fetchRemote with discordCdnOnly rejects non-Discord URLs without network access', async () => {
    const host = await loadHost();

    await expect(
      host.fetchRemote('https://example.com/image.png', {
        discordCdnOnly: true,
      }),
    ).rejects.toThrow('blocked_url');
    expect(fetchPublicHttpsBufferMock).not.toHaveBeenCalled();
  });

  test('fetchRemote delegates to the SSRF-guarded fetch without the host restriction flag', async () => {
    const host = await loadHost();
    const result = {
      body: Buffer.from('x'),
      contentType: 'image/png',
      contentLength: 1,
      url: 'https://cdn.discordapp.com/attachments/1/2/a.png',
    };
    fetchPublicHttpsBufferMock.mockResolvedValueOnce(result);

    await expect(
      host.fetchRemote(result.url, { discordCdnOnly: true, maxBytes: 10 }),
    ).resolves.toBe(result);
    expect(fetchPublicHttpsBufferMock).toHaveBeenCalledWith(result.url, {
      maxBytes: 10,
    });
  });
});
