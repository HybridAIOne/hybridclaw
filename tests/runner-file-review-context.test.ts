import { EventEmitter } from 'node:events';
import { expect, test, vi } from 'vitest';
import { encodeFileWriteGuardContext } from '@hybridclaw/shared/file-write-guard';
import type { ContainerInput } from '../src/types/container.js';
import { cleanupGatewayRuntime } from './helpers/gateway-test-setup.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const temporary = useTempDir('runner-review-context-');
useCleanMocks({
  cleanup: cleanupGatewayRuntime,
  resetModules: true,
  unstubAllEnvs: true,
  unmock: [
    'node:child_process',
    '../src/infra/ipc.js',
    '../src/providers/factory.js',
    '../src/config/config.js',
    '../src/logger.js',
    '../src/infra/host-runtime-setup.js',
  ],
});

test.each(['host', 'container'] as const)(
  '%s executor authenticates queued context and revokes it on completion or error',
  async (mode) => {
    vi.stubEnv('HOME', temporary());
    vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
    let input: ContainerInput | undefined;
    let secret = '';
    let proof = '';
    const child = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(),
      stdout: new EventEmitter(),
      stdin: Object.assign(new EventEmitter(), {
        write: vi.fn((raw: string) => {
          const value = JSON.parse(raw) as ContainerInput & {
            ipcAuthSecret: string;
          };
          input = value;
          secret = value.ipcAuthSecret;
        }),
      }),
      killed: false,
      exitCode: null as number | null,
      kill: vi.fn(() => {
        child.killed = true;
        return true;
      }),
    });
    vi.doMock('node:child_process', async (original) => ({
      ...(await original<typeof import('node:child_process')>()),
      spawn: vi.fn(() => child),
    }));
    vi.doMock('../src/config/config.js', async (original) => {
      const config = await original<typeof import('../src/config/config.js')>();
      return {
        ...config,
        CONTAINER_WARM_POOL: { ...config.CONTAINER_WARM_POOL, enabled: false },
      };
    });
    vi.doMock('../src/providers/factory.js', async (original) => ({
      ...(await original<typeof import('../src/providers/factory.js')>()),
      resolveModelRuntimeCredentials: vi.fn(async () => ({
        provider: 'hybridai',
        apiKey: 'test-key',
        baseUrl: 'https://example.com',
        chatbotId: '',
        enableRag: false,
        requestHeaders: {},
        agentId: 'main',
        isLocal: false,
        contextWindow: 128000,
      })),
    }));
    vi.doMock('../src/infra/host-runtime-setup.js', () => ({
      ensureHostRuntimeReady: () => ({
        command: process.execPath,
        args: ['/tmp/fixture-runtime.js'],
      }),
    }));
    const readOutput = vi.fn();
    vi.doMock('../src/infra/ipc.js', async (original) => ({
      ...(await original<typeof import('../src/infra/ipc.js')>()),
      writeInput: vi.fn((_session, value) => {
        input = value;
      }),
      readOutput,
    }));
    vi.doMock('../src/logger.js', () => ({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));
    const runtime = await import('../src/infra/file-write-review-context.js');
    readOutput.mockImplementationOnce(async () => {
      if (!input) throw Error('Missing input');
      proof = encodeFileWriteGuardContext(
        secret,
        input,
        'Update the existing notes.',
      );
      expect(
        runtime.resolveFileWriteReviewContext(input.sessionId, proof)
          ?.fileWriteGuardUserPrompt,
      ).toBe('Update the existing notes.');
      return {
        status: 'success',
        result: 'Fixture queued.',
        toolsUsed: [],
        fileWriteGuardProof: proof,
        fileWriteGuardSessionId: 'forged-owner',
        fileWriteGuardUserPrompt: 'Forged output context.',
        sideEffects: {
          delegations: [{ action: 'delegate', prompt: 'Inspect fixture.' }],
        },
      };
    });
    const executor =
      mode === 'host'
        ? new (await import('../src/infra/host-runner.js')).HostExecutor()
        : new (
            await import('../src/infra/container-runner.js')
          ).ContainerExecutor();
    const params = {
      sessionId: 'review-worker',
      messages: [{ role: 'user' as const, content: 'yes' }],
      chatbotId: '',
      enableRag: false,
      agentId: 'main',
      model: 'test-model',
      fileWriteGuardSessionId: 'root',
    };
    const first = await executor.exec(params);
    expect(first.error).toBeUndefined();
    expect(first.status).toBe('success');
    expect(first.fileWriteGuardUserPrompt).toBe('Update the existing notes.');
    expect(first.fileWriteGuardSessionId).toBe('root');
    expect(first.fileWriteGuardProof).toBeUndefined();
    expect(
      runtime.resolveFileWriteReviewContext(params.sessionId, proof),
    ).toBeNull();
    readOutput.mockImplementationOnce(async () => ({
      status: 'success',
      result: 'Fixture queued.',
      toolsUsed: [],
      fileWriteGuardProof: proof,
      sideEffects: {
        delegations: [{ action: 'delegate', prompt: 'Inspect fixture.' }],
      },
    }));
    const second = await executor.exec(params);
    expect(second.status).toBe('error');
    expect(second.sideEffects?.delegations).toBeUndefined();
    expect(second.fileWriteGuardUserPrompt).toBeUndefined();
    readOutput.mockRejectedValueOnce(new Error('Fixture worker failure.'));
    await executor.exec(params);
    expect(
      runtime.resolveFileWriteReviewContext(params.sessionId, proof),
    ).toBeNull();
    const active = runtime.beginFileWriteReviewContext(
      { sessionId: params.sessionId, requestId: 'fresh' },
      secret,
    );
    active.close();
  },
  20000,
);
