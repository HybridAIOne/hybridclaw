import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  containerHostAliasArgs,
  remapHostBaseUrlForContainer,
} from '../src/infra/container-host-alias.js';
import { useCleanMocks } from './test-utils.js';

const HOST_ALIAS_ARG = '--add-host=host.docker.internal:host-gateway';
const ORIGINAL_PLATFORM = process.platform;

describe('remapHostBaseUrlForContainer', () => {
  it.each([
    ['http://127.0.0.1:19490/v1', 'http://host.docker.internal:19490/v1'],
    ['http://localhost:11434', 'http://host.docker.internal:11434'],
    ['http://localhost/v1', 'http://host.docker.internal/v1'],
    ['https://api.example.com/v1', 'https://api.example.com/v1'],
    ['http://172.17.0.1:8000/v1', 'http://172.17.0.1:8000/v1'],
    ['http://127.0.0.1.example.com/v1', 'http://127.0.0.1.example.com/v1'],
    ['http://localhost.example.com/v1', 'http://localhost.example.com/v1'],
  ])('maps %s to %s', (input, expected) => {
    expect(remapHostBaseUrlForContainer(input)).toBe(expected);
  });
});

describe('containerHostAliasArgs', () => {
  it.each<[NodeJS.Platform, string, string[]]>([
    ['linux', 'bridge', [HOST_ALIAS_ARG]],
    ['linux', 'hybridclaw-net', [HOST_ALIAS_ARG]],
    ['linux', 'host', [HOST_ALIAS_ARG]],
    ['linux', 'none', []],
    ['linux', 'container:sidecar', []],
    ['darwin', 'bridge', []],
    ['win32', 'bridge', []],
    ['darwin', 'none', []],
  ])('on %s with network %s returns %j', (platform, network, expected) => {
    expect(containerHostAliasArgs(platform, network)).toEqual(expected);
  });
});

function makeFakeChildProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    stdin: { write: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
    exitCode: number | null;
  };
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn() };
  proc.killed = false;
  proc.exitCode = null;
  proc.kill = vi.fn(() => {
    proc.killed = true;
    return true;
  });
  return proc;
}

async function spawnArgsFor(params: {
  platform: NodeJS.Platform;
  network: string;
  modelBaseUrl: string;
}): Promise<{ runArgs: string[]; inputBaseUrl: string }> {
  Object.defineProperty(process, 'platform', { value: params.platform });
  const procs: ReturnType<typeof makeFakeChildProcess>[] = [];
  const spawn = vi.fn(() => {
    const proc = makeFakeChildProcess();
    procs.push(proc);
    return proc as never;
  });
  vi.doMock('node:child_process', async () => ({
    ...(await vi.importActual<typeof import('node:child_process')>(
      'node:child_process',
    )),
    spawn,
  }));
  vi.doMock('../src/config/config.js', async () => ({
    ...(await vi.importActual<typeof import('../src/config/config.js')>(
      '../src/config/config.js',
    )),
    CONTAINER_NETWORK: params.network,
  }));
  vi.doMock('../src/infra/ipc.js', async () => ({
    ...(await vi.importActual<typeof import('../src/infra/ipc.js')>(
      '../src/infra/ipc.js',
    )),
    readOutput: vi.fn(async () => ({
      status: 'success' as const,
      result: 'ok',
      toolsUsed: [],
      artifacts: [],
    })),
  }));
  vi.doMock('../src/providers/factory.js', async () => ({
    ...(await vi.importActual<typeof import('../src/providers/factory.js')>(
      '../src/providers/factory.js',
    )),
    resolveModelRuntimeCredentials: vi.fn(async () => ({
      provider: 'vllm' as const,
      apiKey: '',
      baseUrl: params.modelBaseUrl,
      chatbotId: '',
      enableRag: false,
      requestHeaders: {},
      agentId: 'default',
      isLocal: true,
      contextWindow: 32_000,
      thinkingFormat: undefined,
    })),
  }));
  vi.doMock('../src/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }));

  const { ContainerExecutor } = await import(
    '../src/infra/container-runner.js'
  );
  await new ContainerExecutor().exec({
    sessionId: `session-host-alias-${params.platform}-${params.network}`,
    messages: [{ role: 'user', content: 'hello' }],
    chatbotId: '',
    enableRag: false,
    model: 'vllm/test-model',
    agentId: 'default',
    channelId: 'tui',
  });
  const runIndex = spawn.mock.calls.findIndex(
    (call) => call[0] === 'docker' && (call[1] as string[])[0] === 'run',
  );
  if (runIndex < 0) throw new Error('docker run was not spawned');
  const stdinLine = procs[runIndex].stdin.write.mock.calls[0][0] as string;
  return {
    runArgs: spawn.mock.calls[runIndex][1] as string[],
    inputBaseUrl: (JSON.parse(stdinLine) as { baseUrl: string }).baseUrl,
  };
}

describe('ContainerExecutor docker run args', () => {
  useCleanMocks({
    restoreAllMocks: true,
    resetModules: true,
    unmock: [
      'node:child_process',
      '../src/config/config.js',
      '../src/infra/ipc.js',
      '../src/providers/factory.js',
      '../src/logger.js',
    ],
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM });
  });

  it.each([
    ['http://127.0.0.1:19490/v1', 'http://host.docker.internal:19490/v1'],
    ['https://api.example.com/v1', 'https://api.example.com/v1'],
  ])(
    'maps the host alias on Linux bridge networking for model URL %s',
    async (modelBaseUrl, expectedBaseUrl) => {
      const { runArgs, inputBaseUrl } = await spawnArgsFor({
        platform: 'linux',
        network: 'bridge',
        modelBaseUrl,
      });
      expect(inputBaseUrl).toBe(expectedBaseUrl);
      expect(runArgs.filter((arg) => arg === HOST_ALIAS_ARG)).toHaveLength(1);
      expect(runArgs.indexOf(HOST_ALIAS_ARG)).toBeLessThan(runArgs.length - 1);
      expect(runArgs).toContain('--network=bridge');
    },
  );

  it.each<[NodeJS.Platform, string]>([
    ['linux', 'none'],
    ['linux', 'container:sidecar'],
    ['darwin', 'bridge'],
    ['win32', 'bridge'],
  ])(
    'adds no host mapping on %s with network %s',
    async (platform, network) => {
      const { runArgs, inputBaseUrl } = await spawnArgsFor({
        platform,
        network,
        modelBaseUrl: 'http://127.0.0.1:19490/v1',
      });
      expect(inputBaseUrl).toBe('http://host.docker.internal:19490/v1');
      expect(runArgs.some((arg) => arg.startsWith('--add-host'))).toBe(false);
      expect(runArgs).toContain(`--network=${network}`);
    },
  );
});
