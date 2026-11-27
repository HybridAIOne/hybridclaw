import fs from 'node:fs';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';
import {
  baseRequest,
  firstInput,
  okOutput,
  RUNNER_MODES,
  testCredentials,
  useRunnerModes,
} from './helpers/worker-runner-modes.js';

const startRunner = useRunnerModes('hybridclaw-container-runner-spawn-');
const container = RUNNER_MODES.find((mode) => mode.mode === 'container')!;

test('containerRunner injects the gateway runtime env into the docker launch', async () => {
  vi.stubEnv('GATEWAY_API_TOKEN', 'gateway-secret');
  const { runner, workerCalls } = await startRunner(container);

  await runner.exec({ ...baseRequest, sessionId: 'session-gateway-env' });

  const runArgs = workerCalls[0]?.[1];
  expect(runArgs).toContain(
    'HYBRIDCLAW_GATEWAY_URL=http://host.docker.internal:9090',
  );
  const { deriveAgentRuntimeToken } = await import(
    '../src/security/agent-runtime-token.js'
  );
  expect(runArgs).toContain(
    `HYBRIDCLAW_GATEWAY_TOKEN=${deriveAgentRuntimeToken('gateway-secret')}`,
  );
  expect(runArgs?.join('\n')).not.toContain('gateway-secret');
  expect(runArgs).toContain(
    `TZ=${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
  );
  expect(runArgs).toContain('HYBRIDCLAW_AGENT_SANDBOX_MODE=container');
});

test('containerRunner stages the container node_modules symlink before the docker launch', async () => {
  const { runner, workerCalls } = await startRunner(container);
  const { getSessionPaths } = await import('../src/infra/ipc.js');
  const { workspacePath } = getSessionPaths('session-node-link', 'default');
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.symlinkSync(
    '/Users/example/project/node_modules',
    path.join(workspacePath, 'node_modules'),
    'dir',
  );

  await runner.exec({ ...baseRequest, sessionId: 'session-node-link' });

  expect(fs.readlinkSync(path.join(workspacePath, 'node_modules'))).toBe(
    '/app/node_modules',
  );
  expect(workerCalls[0]?.[1]).toContain(`${workspacePath}:/workspace:rw`);
});

const MLX_KEY = 'mlx-test-key-0123456789';
const MLX_URL = 'http://127.0.0.1:8080/v1';
const RELAY = {
  apiKey: '',
  baseUrl: 'http://mlx.invalid/v1',
  requestHeaders: {
    'X-HybridClaw-Relay': expect.stringMatching(/^[a-f0-9]{32}$/),
  },
};
const mlxCredentials = testCredentials({
  provider: 'mlx',
  apiKey: MLX_KEY,
  baseUrl: MLX_URL,
  chatbotId: '',
  isLocal: true,
});
const mlxTaskModel = (model: string, baseUrl = MLX_URL) => ({
  provider: 'mlx',
  baseUrl,
  apiKey: MLX_KEY,
  requestHeaders: {},
  isLocal: true,
  model,
});

afterEach(() => {
  vi.doUnmock('../src/inference/mlx-relay.js');
});

function trackRelays() {
  const relays: Array<{
    id: string;
    model: string;
    stop: ReturnType<typeof vi.fn>;
  }> = [];
  vi.doMock('../src/inference/mlx-relay.js', async (importOriginal) => {
    const actual =
      await importOriginal<typeof import('../src/inference/mlx-relay.js')>();
    return {
      ...actual,
      startMlxRelay: (options: Parameters<typeof actual.startMlxRelay>[0]) => {
        const relay = actual.startMlxRelay(options);
        const stop = vi.fn(() => relay.stop());
        relays.push({ id: relay.id, model: options.model, stop });
        return { id: relay.id, stop };
      },
    };
  });
  return relays;
}

function stdinBytes(worker: { stdin: { write: ReturnType<typeof vi.fn> } }) {
  return worker.stdin.write.mock.calls.map(([chunk]) => String(chunk)).join('');
}

function relayIds(input: Record<string, unknown>) {
  const taskModels = Object.values(
    (input.taskModels || {}) as Record<
      string,
      { requestHeaders?: Record<string, string> }
    >,
  );
  return [input, ...taskModels]
    .map(
      (entry) =>
        (entry.requestHeaders as Record<string, string> | undefined)?.[
          'X-HybridClaw-Relay'
        ],
    )
    .filter(Boolean);
}

test('containerRunner sends MLX turns and their task models through relays without the provider key or URL', async () => {
  const relays = trackRelays();
  const { runner, workers } = await startRunner(container, {
    credentials: async () => mlxCredentials,
  });

  await runner.exec({
    ...baseRequest,
    sessionId: 'session-mlx-relay',
    chatbotId: '',
    model: 'mlx/test-model',
  });

  expect(workers[0]?.stdin.write).toHaveBeenCalledTimes(1);
  const input = firstInput(workers[0]);
  expect(input).toMatchObject({
    ...RELAY,
    taskModels: { vision: { ...RELAY, provider: 'mlx' } },
  });
  const bytes = stdinBytes(workers[0]!);
  expect(bytes).not.toContain(MLX_KEY);
  expect(bytes).not.toContain('127.0.0.1:8080');
  const ids = relayIds(input);
  expect(ids.length).toBeGreaterThan(1);
  expect(new Set(ids).size).toBe(ids.length);
  expect(relays).toHaveLength(ids.length);
  expect(relays.every((relay) => relay.model === 'test-model')).toBe(true);
  expect(relays.every((relay) => relay.stop.mock.calls.length === 1)).toBe(
    true,
  );
});

test('containerRunner relays an MLX task model when the session model is not MLX', async () => {
  const relays = trackRelays();
  const { runner, workers } = await startRunner(container, {
    taskModels: () => ({
      vision: mlxTaskModel('mlx/vision-model'),
      btw: { provider: 'hybridai', model: 'gpt-5', apiKey: 'hybridai-key' },
    }),
  });

  await runner.exec({ ...baseRequest, sessionId: 'session-mlx-task' });

  const input = firstInput(workers[0]);
  expect(input.provider).toBe('hybridai');
  expect(input.requestHeaders).not.toHaveProperty('X-HybridClaw-Relay');
  expect(input.taskModels).toEqual({
    vision: {
      ...RELAY,
      provider: 'mlx',
      isLocal: true,
      model: 'mlx/vision-model',
    },
    btw: { provider: 'hybridai', model: 'gpt-5', apiKey: 'hybridai-key' },
  });
  const bytes = stdinBytes(workers[0]!);
  expect(bytes).not.toContain(MLX_KEY);
  expect(bytes).not.toContain('127.0.0.1:8080');
  expect(relays.map((relay) => relay.model)).toEqual(['vision-model']);
  expect(relays[0]?.stop).toHaveBeenCalledTimes(1);
});

test('containerRunner stops every relay it started when the turn fails', async () => {
  const relays = trackRelays();
  const { runner } = await startRunner(container, {
    credentials: async () => mlxCredentials,
    taskModels: () => ({
      vision: mlxTaskModel('mlx/vision-model'),
      compression: mlxTaskModel('mlx/test-model'),
    }),
    readOutput: async () => {
      throw new Error('worker exited');
    },
  });

  const result = await runner.exec({
    ...baseRequest,
    sessionId: 'session-mlx-fail',
    chatbotId: '',
    model: 'mlx/test-model',
  });

  expect(result.status).toBe('error');
  expect(relays).toHaveLength(3);
  for (const relay of relays) expect(relay.stop).toHaveBeenCalledTimes(1);
});

test('containerRunner fails an MLX task model closed when its relay cannot start', async () => {
  const relays = trackRelays();
  const { runner, workers } = await startRunner(container, {
    taskModels: () => ({
      vision: mlxTaskModel('mlx/vision-model', 'http://10.0.0.5:8080/v1'),
      btw: mlxTaskModel('mlx/test-model'),
    }),
  });

  const result = await runner.exec({
    ...baseRequest,
    sessionId: 'session-mlx-task-invalid',
  });

  expect(result.status).toBe('success');
  const input = firstInput(workers[0]);
  expect(input.taskModels).toMatchObject({
    vision: {
      provider: 'mlx',
      model: 'mlx/vision-model',
      error: expect.any(String),
    },
    btw: { ...RELAY, provider: 'mlx' },
  });
  const bytes = stdinBytes(workers[0]!);
  expect(bytes).not.toContain(MLX_KEY);
  expect(bytes).not.toContain('10.0.0.5');
  expect(relays.map((relay) => relay.model)).toEqual(['test-model']);
  expect(relays[0]?.stop).toHaveBeenCalledTimes(1);
});

test('containerRunner hands a reused worker the running relays of its current turn', async () => {
  const relays = trackRelays();
  const sessionId = 'session-mlx-reuse';
  let followUp = '';
  let runningDuringFollowUp: string[] = [];
  let turn = 0;
  const { runner, workers } = await startRunner(container, {
    credentials: async () => mlxCredentials,
    taskModels: () => ({ vision: mlxTaskModel('mlx/vision-model') }),
    readOutput: async () => {
      turn += 1;
      if (turn === 2) {
        const { getSessionPaths } = await import('../src/infra/ipc.js');
        const { ipcPath } = getSessionPaths(sessionId, 'default');
        followUp = fs.readFileSync(path.join(ipcPath, 'input.json'), 'utf-8');
        runningDuringFollowUp = relays
          .filter((relay) => relay.stop.mock.calls.length === 0)
          .map((relay) => relay.id);
      }
      return okOutput();
    },
  });
  const request = {
    ...baseRequest,
    sessionId,
    chatbotId: '',
    model: 'mlx/test-model',
  };

  await runner.exec(request);
  await runner.exec(request);

  expect(workers).toHaveLength(1);
  const first = firstInput(workers[0]);
  const { decodeAuthenticatedInput } = await import(
    '@hybridclaw/shared/ipc-input-auth'
  );
  const decoded = decodeAuthenticatedInput(
    String(first.ipcAuthSecret),
    followUp,
  );
  if (decoded.status !== 'ok') throw new Error('expected authentic input');
  const second = JSON.parse(decoded.body) as Record<string, unknown>;
  expect(second).toMatchObject({
    ...RELAY,
    taskModels: { vision: { ...RELAY, provider: 'mlx' } },
  });
  const secondIds = relayIds(second);
  expect(secondIds).toHaveLength(2);
  expect(secondIds.some((id) => relayIds(first).includes(id))).toBe(false);
  expect(runningDuringFollowUp).toEqual(secondIds);
  expect(decoded.body).not.toContain(MLX_KEY);
  expect(decoded.body).not.toContain('127.0.0.1:8080');
});
