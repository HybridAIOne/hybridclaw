import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { cleanupGatewayRuntime } from './helpers/gateway-test-setup.js';
import { mockIpcWatcher } from './helpers/ipc-watcher.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const temp = useTempDir('hc-deadline-ipc-');
const active: Array<{ controller: AbortController; output: Promise<unknown> }> =
  [];
useCleanMocks({
  resetModules: true,
  restoreAllMocks: true,
  unstubAllEnvs: true,
  cleanup: async () => {
    for (const { controller } of active) controller.abort();
    await vi.advanceTimersByTimeAsync(2001);
    await Promise.allSettled(active.splice(0).map(({ output }) => output));
    vi.useRealTimers();
    await cleanupGatewayRuntime();
  },
});
beforeEach(() => {
  const home = temp();
  vi.stubEnv('HOME', home);
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', home);
  vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
  mockIpcWatcher();
  vi.useFakeTimers();
});

test.each([false, true])(
  'the original budget includes preparation and survives activity (tracking=%s)',
  async (tracking) => {
    const ipc = await import('../src/infra/ipc.js');
    ipc.ensureSessionDirs('session');
    const executionDeadlineAtMs = Date.now() + 1000;
    await vi.advanceTimersByTimeAsync(600);
    const controller = new AbortController();
    const done = vi.fn();
    const activity = tracking ? ipc.createActivityTracker() : undefined;
    const output = ipc
      .readOutput('session', 'request', null, {
        executionDeadlineAtMs,
        maxWallClockMs: 9000,
        activity,
        signal: controller.signal,
      })
      .then((r) => {
        done(r);
        return r;
      });
    active.push({ controller, output });
    await vi.advanceTimersByTimeAsync(399);
    activity?.notify();
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalledOnce();
    await expect(output).resolves.toMatchObject({
      status: 'error',
      error: expect.stringMatching(/Timeout.*deadline exceeded/),
    });
  },
);

test('an explicit absolute budget never extends the existing earlier inactivity stop', async () => {
  const ipc = await import('../src/infra/ipc.js');
  ipc.ensureSessionDirs('session');
  const controller = new AbortController();
  const output = ipc.readOutput('session', 'request', 100, {
    executionDeadlineAtMs: Date.now() + 9000,
    signal: controller.signal,
  });
  active.push({ controller, output });
  await vi.advanceTimersByTimeAsync(100);
  await expect(output).resolves.toMatchObject({
    status: 'error',
    error:
      'Timeout waiting for agent output after 100ms total (100ms inactivity window)',
  });
});

test('deadline cancellation retains late measured usage without honoring queued effects', async () => {
  const ipc = await import('../src/infra/ipc.js');
  ipc.ensureSessionDirs('session');
  const dir = ipc.getSessionPaths('session', 'main').ipcPath;
  const { ExecutionDeadlineError } = await import(
    '../packages/shared/src/execution-deadline.js'
  );
  const { createTokenUsageStats } = await import(
    '../packages/shared/src/token-usage.js'
  );
  const { ipcOutputFileName } = await import(
    '../packages/shared/src/ipc-output-files.js'
  );
  const controller = new AbortController();
  const output = ipc.readOutput('session', 'request', null, {
    signal: controller.signal,
  });
  active.push({ controller, output });
  controller.abort(new ExecutionDeadlineError());
  fs.writeFileSync(
    path.join(dir, ipcOutputFileName('request')),
    JSON.stringify({
      status: 'success',
      result: 'late',
      toolsUsed: [],
      tokenUsage: {
        ...createTokenUsageStats(),
        modelCalls: 1,
        apiUsageAvailable: true,
        apiPromptTokens: 7,
        apiCompletionTokens: 3,
        apiTotalTokens: 10,
      },
      sideEffects: {
        delegations: [{ action: 'delegate', prompt: 'Synthetic task' }],
      },
    }),
  );
  await vi.advanceTimersByTimeAsync(1000);
  const result = await output;
  expect(result.status).toBe('error');
  expect(result.error).toContain('deadline exceeded');
  expect(result.tokenUsage?.apiTotalTokens).toBe(10);
  expect(result.sideEffects).toBeUndefined();
});

test('gateway cancellation at the absolute deadline still collects validated shutdown usage', async () => {
  const ipc = await import('../src/infra/ipc.js');
  ipc.ensureSessionDirs('session');
  const { ExecutionDeadlineError } = await import(
    '../packages/shared/src/execution-deadline.js'
  );
  const { createTokenUsageStats } = await import(
    '../packages/shared/src/token-usage.js'
  );
  const { ipcOutputFileName } = await import(
    '../packages/shared/src/ipc-output-files.js'
  );
  const controller = new AbortController(),
    deadline = Date.now() + 100;
  setTimeout(() => controller.abort(new ExecutionDeadlineError()), 100);
  const output = ipc.readOutput('session', 'request', null, {
    signal: controller.signal,
    executionDeadlineAtMs: deadline,
  });
  active.push({ controller, output });
  setTimeout(
    () =>
      fs.writeFileSync(
        path.join(
          ipc.getSessionPaths('session', 'main').ipcPath,
          ipcOutputFileName('request'),
        ),
        JSON.stringify({
          status: 'success',
          result: 'late',
          toolsUsed: [],
          tokenUsage: {
            ...createTokenUsageStats(),
            modelCalls: 1,
            apiUsageAvailable: true,
            apiPromptTokens: 7,
            apiCompletionTokens: 3,
            apiTotalTokens: 10,
          },
        }),
      ),
    200,
  );
  await vi.advanceTimersByTimeAsync(1250);
  await expect(output).resolves.toMatchObject({
    status: 'error',
    error: expect.stringContaining('deadline exceeded'),
    tokenUsage: { apiTotalTokens: 10 },
  });
});
