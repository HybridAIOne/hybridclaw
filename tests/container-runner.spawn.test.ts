import fs from 'node:fs';
import path from 'node:path';

import { expect, test, vi } from 'vitest';
import {
  baseRequest,
  firstInput,
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

test('containerRunner sends MLX turns through the relay without the provider key', async () => {
  const { runner, workers } = await startRunner(container, {
    credentials: async () =>
      testCredentials({
        provider: 'mlx',
        apiKey: 'mlx-test-key-0123456789',
        baseUrl: 'http://127.0.0.1:8080/v1',
        chatbotId: '',
        isLocal: true,
      }),
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
    apiKey: '',
    baseUrl: 'http://mlx.invalid/v1',
    requestHeaders: {
      'X-HybridClaw-Relay': expect.stringMatching(/^[a-f0-9]{32}$/),
    },
  });
  // Task models resolved to MLX still carry the raw key on main and here;
  // the relay covers only the turn's own model (reported separately).
  const { taskModels: _taskModels, ...turn } = input;
  expect(JSON.stringify(turn)).not.toContain('mlx-test-key-0123456789');
});
