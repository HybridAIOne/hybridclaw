import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import type { ServerResponse } from 'node:http';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const mint = vi.hoisted(() => vi.fn());
vi.mock('../src/auth/google-auth.js', () => ({
  resolveGoogleWorkspaceRuntimeEnv: mint,
  getGoogleWorkspaceRuntimeEnvRecoveryHint: () => 'Google login required',
}));
vi.mock('../src/logger.js', () => ({ logger: { warn: vi.fn() } }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});
const makeTemp = useTempDir('shell-env-');
useCleanMocks({
  unstubAllEnvs: true,
  unstubAllGlobals: true,
  resetModules: true,
});

function response() {
  return {
    setHeader: vi.fn(),
    writeHead: vi.fn(),
    end: vi.fn(),
    statusCode: 0,
  };
}

test('credential endpoint rejects callers without gateway authentication before resolving secrets', async () => {
  const { handleApiShellEnv } = await import(
    '../src/gateway/gateway-shell-env.js'
  );
  const res = response();
  mint.mockClear();
  await handleApiShellEnv(res as unknown as ServerResponse, false);
  expect(mint).not.toHaveBeenCalled();
  expect(res.writeHead).toHaveBeenCalledWith(401, expect.anything());
});

test.each([false, true])(
  'shell endpoint returns uncached short-lived credentials, tolerating revoked OAuth (revoked=%s)',
  async (revoked) => {
    const { handleApiShellEnv } = await import(
      '../src/gateway/gateway-shell-env.js'
    );
    const env = {
      GOG_ACCESS_TOKEN: 'test-key',
      GOOGLE_WORKSPACE_CLI_TOKEN: 'test-key',
    };
    if (revoked) mint.mockRejectedValue(new Error('invalid_grant'));
    else mint.mockResolvedValue(env);
    const res = response();
    await handleApiShellEnv(res as unknown as ServerResponse, true);
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(JSON.parse(String(res.end.mock.calls[0][0]))).toEqual(
      revoked ? {} : env,
    );
  },
);

test('runtime handoff filters unexpected environment names and rejects malformed responses without echoing secrets', async () => {
  const { resolveShellRuntimeEnv } = await import(
    '../container/src/shell-runtime-env.js'
  );
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        GOG_ACCESS_TOKEN: 'test-key',
        GOOGLE_WORKSPACE_CLI_TOKEN: 'bad\0value',
        NODE_OPTIONS: '--require malicious',
      }),
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  expect(
    await resolveShellRuntimeEnv('http://localhost:9090', 'gateway-key'),
  ).toEqual({ GOG_ACCESS_TOKEN: 'test-key' });
  expect(fetchMock).toHaveBeenCalledWith(
    'http://localhost:9090/api/runtime/shell-env',
    expect.objectContaining({
      redirect: 'error',
      headers: { Authorization: 'Bearer gateway-key' },
    }),
  );
  fetchMock.mockResolvedValue(new Response('test-secret-invalid-json'));
  await expect(
    resolveShellRuntimeEnv('http://localhost:9090', 'gateway-key'),
  ).rejects.toThrow('Invalid shell credential response.');
  fetchMock.mockResolvedValue(new Response('test-secret', { status: 401 }));
  await expect(
    resolveShellRuntimeEnv('http://localhost:9090', 'gateway-key'),
  ).rejects.toThrow('Unable to resolve shell credentials.');
});

test.each([false, true])(
  'approved bash receives refreshed credentials without persisting them (persistent=%s)',
  async (persistent) => {
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', makeTemp());
    vi.stubEnv('HYBRIDCLAW_BASH_DOCKER_CONTAINER', '');
    const tools = await import('../container/src/tools.js');
    tools.setGatewayContext('http://localhost:9090', 'gateway-key');
    tools.setPersistentBashStateEnabled(persistent);
    const fetchMock = vi
      .fn()
      .mockImplementation(
        async () =>
          new Response(JSON.stringify({ GOG_ACCESS_TOKEN: 'test-key' })),
      );
    vi.stubGlobal('fetch', fetchMock);
    try {
      await tools.executeTool(
        'bash',
        JSON.stringify({ command: 'eval "printf blocked"' }),
      );
      expect(fetchMock).not.toHaveBeenCalled();
      for (const token of ['test-key', 'refreshed-test-key']) {
        fetchMock.mockImplementation(
          async () => new Response(JSON.stringify({ GOG_ACCESS_TOKEN: token })),
        );
        const result = await tools.executeTool(
          'bash',
          JSON.stringify({
            command: `test "$GOG_ACCESS_TOKEN" = '${token}' && printf ok`,
          }),
        );
        expect(result).toBe('ok');
        const [, args, options] = vi.mocked(spawnSync).mock.calls.at(-1)!;
        expect(JSON.stringify(args)).not.toContain(token);
        expect(options).toMatchObject({ env: { GOG_ACCESS_TOKEN: token } });
        if (persistent) {
          const snapshot = args!.find((arg) =>
            arg.endsWith('/state.snapshot'),
          )!;
          expect(fs.readFileSync(snapshot, 'utf8')).not.toContain(token);
        }
      }
    } finally {
      tools.resetPersistentBashSessions();
    }
  },
);

test('Docker exec passes token names in argv and values only in its environment', async () => {
  vi.stubEnv('HYBRIDCLAW_BASH_DOCKER_CONTAINER', 'test-sandbox');
  const { runBashProcess } = await import('../container/src/bash-process.js');
  vi.mocked(spawnSync).mockReturnValue({
    pid: 1,
    status: 0,
    signal: null,
    stdout: '',
    stderr: '',
    output: [],
  });
  runBashProcess(['-c', 'true'], {
    command: 'true',
    timeoutMs: 1000,
    runtimeEnv: { GOG_ACCESS_TOKEN: 'test-key' },
  });
  const [file, args, options] = vi.mocked(spawnSync).mock.calls.at(-1)!;
  expect(file).toBe('docker');
  expect(args).toContain('GOG_ACCESS_TOKEN');
  expect(args).not.toContain('test-key');
  expect(options).toMatchObject({ env: { GOG_ACCESS_TOKEN: 'test-key' } });
});

test.each([false, true])(
  'shell metacharacters in workspace and temporary paths stay literal (persistent=%s)',
  async (persistent) => {
    const actual =
      await vi.importActual<typeof import('node:child_process')>(
        'node:child_process',
      );
    vi.mocked(spawnSync).mockImplementation(actual.spawnSync);
    const root = makeTemp();
    const workspace = path.join(
      root,
      `workspace ' " $(printf injected); space`,
    );
    const temp = path.join(root, `temp ' " $(printf injected); space`);
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, 'marker'), 'ok');
    fs.mkdirSync(temp);
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspace);
    vi.stubEnv('TMPDIR', temp);
    vi.stubEnv('HYBRIDCLAW_BASH_DOCKER_CONTAINER', '');
    const tools = await import('../container/src/tools.js');
    tools.setPersistentBashStateEnabled(persistent);
    try {
      for (let turn = 0; turn < 2; turn++) {
        const command = 'cat marker';
        const output = await tools.executeTool(
          'bash',
          JSON.stringify({ command }),
        );
        expect(output.trim()).toBe('ok');
        const [executable, args, options] = vi
          .mocked(spawnSync)
          .mock.calls.at(-1)!;
        expect(executable).toBe('bash');
        expect(args![1]).not.toContain(workspace);
        expect(args![1]).not.toContain(temp);
        expect(options).toMatchObject({
          cwd: workspace,
          input: `${command}\0`,
        });
      }
    } finally {
      tools.resetPersistentBashSessions();
    }
  },
);
