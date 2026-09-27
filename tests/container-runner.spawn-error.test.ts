import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';

import pino from 'pino';
import { expect, test, vi } from 'vitest';

import { LOGGER_ERROR_KEY, LOGGER_SERIALIZERS } from '../src/logger-format.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const GATEWAY_TOKEN = 'gateway-token-sentinel-7f3a9c';

const makeTempDir = useTempDir('hybridclaw-container-spawn-error-');
useCleanMocks({
  resetModules: true,
  restoreAllMocks: true,
  unstubAllEnvs: true,
  unmock: [
    'node:child_process',
    '../src/infra/ipc.js',
    '../src/providers/factory.js',
    '../src/logger.js',
  ],
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

test('logs a failed docker spawn without the child argv', async () => {
  vi.stubEnv('HOME', makeTempDir());
  vi.stubEnv('GATEWAY_API_TOKEN', GATEWAY_TOKEN);
  vi.resetModules();

  let logOutput = '';
  const logSink = new Writable({
    write(chunk, _encoding, callback) {
      logOutput += chunk.toString('utf-8');
      callback();
    },
  });
  const dockerRun = makeFakeChildProcess();
  const spawn = vi.fn(
    (
      _command: string,
      args: string[],
      _options?: { env?: NodeJS.ProcessEnv },
    ) => (args[0] === 'run' ? dockerRun : makeFakeChildProcess()),
  );
  const dockerRunCall = () =>
    spawn.mock.calls.find(([, args]) => args[0] === 'run');
  const readOutput = vi.fn(
    async (
      _sessionId: string,
      _requestId: string,
      _timeoutMs: number,
      opts?: { terminalError?: () => string | null },
    ) => {
      // Node's async spawn failure (ENOENT, EACCES, EAGAIN, EMFILE, ENFILE)
      // copies the child's argv into `spawnargs`.
      dockerRun.emit(
        'error',
        Object.assign(new Error('spawn docker ENOENT'), {
          errno: -2,
          code: 'ENOENT',
          syscall: 'spawn docker',
          path: 'docker',
          spawnargs: dockerRunCall()?.[1],
        }),
      );
      return {
        status: 'error' as const,
        result: null,
        toolsUsed: [],
        artifacts: [],
        error: opts?.terminalError?.() || 'missing terminal error',
      };
    },
  );
  const resolveModelRuntimeCredentials = vi.fn(async () => ({
    provider: 'hybridai' as const,
    apiKey: '',
    baseUrl: 'https://hybridai.one',
    chatbotId: 'bot-a',
    enableRag: false,
    requestHeaders: {},
    agentId: 'default',
    isLocal: false,
    contextWindow: 128_000,
    thinkingFormat: undefined,
  }));

  vi.doMock('node:child_process', async () => ({
    ...(await vi.importActual<typeof import('node:child_process')>(
      'node:child_process',
    )),
    spawn,
  }));
  vi.doMock('../src/infra/ipc.js', async () => ({
    ...(await vi.importActual<typeof import('../src/infra/ipc.js')>(
      '../src/infra/ipc.js',
    )),
    readOutput,
  }));
  vi.doMock('../src/providers/factory.js', async () => ({
    ...(await vi.importActual<typeof import('../src/providers/factory.js')>(
      '../src/providers/factory.js',
    )),
    resolveModelRuntimeCredentials,
  }));
  // The gateway logger's own serializers, so the assertion covers what
  // reaches the log file rather than the raw payload.
  vi.doMock('../src/logger.js', () => ({
    logger: pino(
      {
        errorKey: LOGGER_ERROR_KEY,
        level: 'trace',
        serializers: LOGGER_SERIALIZERS,
      },
      logSink,
    ),
  }));

  const { ContainerExecutor } = await import(
    '../src/infra/container-runner.js'
  );
  const output = await new ContainerExecutor().exec({
    sessionId: 'session-spawn-error',
    messages: [{ role: 'user', content: 'hello' }],
    chatbotId: 'bot-a',
    enableRag: false,
    model: 'gpt-5',
    agentId: 'default',
    channelId: 'tui',
  });

  const workerCredential = String(
    dockerRunCall()?.[2]?.env?.HYBRIDCLAW_GATEWAY_TOKEN,
  );
  expect(workerCredential).toMatch(/^hcw_/);
  expect(logOutput).toContain('"msg":"Container error"');
  expect(logOutput).toContain('"syscall":"spawn docker"');
  expect(logOutput).not.toContain('"spawnargs"');
  expect(output.error).toContain('spawn docker ENOENT');
  for (const credential of [GATEWAY_TOKEN, workerCredential]) {
    expect(logOutput).not.toContain(credential);
    expect(output.error).not.toContain(credential);
  }
});
