import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
let stop: (() => void) | undefined;
useCleanMocks({
  unstubAllEnvs: true,
  resetModules: true,
  cleanup: () => {
    stop?.();
    stop = undefined;
  },
  unmock: [
    'node:child_process',
    '../src/infra/ipc.js',
    '../src/providers/factory.js',
    '../src/infra/host-runtime-setup.js',
  ],
});

test('host workers execute in the task directory and keep their node modules and state agent-local', async () => {
  const data = tempDir();
  const task = tempDir();
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', data);
  vi.stubEnv('HYBRIDCLAW_AGENT_STATE_ROOT', '/untrusted-inherited-root');
  fs.writeFileSync(path.join(task, 'input.txt'), 'input');
  const child = Object.assign(new EventEmitter(), {
    stdin: Object.assign(new EventEmitter(), { write: vi.fn((_chunk: string) => true) }),
    stderr: new EventEmitter(),
    killed: false,
    exitCode: null as number | null,
    kill: vi.fn(() => true),
  });
  const spawn = vi.fn(() => child);
  vi.doMock('node:child_process', async (original) => ({
    ...(await original<typeof import('node:child_process')>()),
    spawn,
  }));
  vi.doMock('../src/infra/host-runtime-setup.js', () => ({
    ensureHostRuntimeReady: () => ({ command: process.execPath, args: [] }),
  }));
  vi.doMock('../src/infra/ipc.js', async (original) => ({
    ...(await original<typeof import('../src/infra/ipc.js')>()),
    readOutput: async () => ({
      status: 'success',
      result: 'done',
      toolsUsed: [],
      artifacts: [],
    }),
  }));
  vi.doMock('../src/providers/factory.js', async (original) => ({
    ...(await original<typeof import('../src/providers/factory.js')>()),
    resolveModelRuntimeCredentials: async () => ({
      provider: 'openrouter',
      apiKey: 'test-key',
      baseUrl: 'https://openrouter.ai/api/v1',
      chatbotId: '',
      enableRag: false,
      requestHeaders: {},
      agentId: 'main',
      isLocal: false,
      model: 'test-model',
    }),
  }));
  const { HostExecutor } = await import('../src/infra/host-runner.js');
  const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
  const executor = new HostExecutor();
  stop = () => executor.stopAll();
  const result = await executor.exec({
    sessionId: 'isolated-task',
    agentId: 'main',
    model: 'test-model',
    chatbotId: '',
    enableRag: false,
    workspacePathOverride: task,
    workspaceDisplayRootOverride: task,
    visualMediaAllowed: true,
    primaryModelSupportsVisualMedia: false,
    messages: [{ role: 'user', content: 'Inspect input.txt' }],
  });
  expect(result.status).toBe('success');
  const input = JSON.parse(child.stdin.write.mock.calls[0][0]);
  expect(input).toMatchObject({ visualMediaAllowed: true, primaryModelSupportsVisualMedia: false });
  const options = spawn.mock.calls[0][2] as unknown as {
    cwd: string;
    env: NodeJS.ProcessEnv;
  };
  expect(options.cwd).toBe(task);
  expect(options.env.HYBRIDCLAW_AGENT_WORKSPACE_ROOT).toBe(task);
  expect(options.env.HYBRIDCLAW_AGENT_STATE_ROOT).toBe(
    path.resolve(agentWorkspaceDir('main')),
  );
  expect(
    fs
      .lstatSync(path.join(agentWorkspaceDir('main'), 'node_modules'))
      .isSymbolicLink(),
  ).toBe(true);
  expect(fs.readdirSync(task)).toEqual(['input.txt']);
});
