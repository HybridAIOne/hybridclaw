import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { ipcOutputFileName } from '@hybridclaw/shared/ipc-output-files';
import { createTokenUsageStats } from '@hybridclaw/shared/token-usage';
import {
  TurnCheckpoint,
  turnCheckpointPath,
} from '@hybridclaw/shared/turn-checkpoint';
import type { ContainerOutput } from '../src/types/container.js';
import { cleanupGatewayRuntime } from './helpers/gateway-test-setup.js';
import { mockIpcWatcher } from './helpers/ipc-watcher.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const temp = useTempDir('hybridclaw-interrupted-usage-');
let pending: Promise<ContainerOutput> | undefined;
let controller: AbortController;
useCleanMocks({
  restoreAllMocks: true,
  resetModules: true,
  unstubAllEnvs: true,
  cleanup: async () => {
    controller.abort();
    await vi.advanceTimersByTimeAsync(2_001);
    await pending;
    pending = undefined;
    vi.useRealTimers();
    await cleanupGatewayRuntime();
  },
});
beforeEach(() => {
  const home = temp();
  vi.stubEnv('HOME', home);
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', home);
  vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
  controller = new AbortController();
  vi.useFakeTimers();
});

const usage = {
  ...createTokenUsageStats(),
  modelCalls: 1,
  apiUsageAvailable: true,
  apiPromptTokens: 120,
  apiCompletionTokens: 12,
  apiTotalTokens: 132,
  apiCacheUsageAvailable: true,
  apiCacheReadTokens: 16,
  performanceSamples: [
    {
      promptTokens: 120,
      completionTokens: 12,
      totalTokens: 132,
      durationMs: 50,
      firstTextDeltaMs: 20,
    },
  ],
};

async function interruptedRead() {
  const watcher = mockIpcWatcher();
  const ipc = await import('../src/infra/ipc.js');
  ipc.ensureSessionDirs('example-session');
  const dir = ipc.getSessionPaths('example-session', 'main').ipcPath;
  pending = ipc.readOutput('example-session', 'example-request', 10_000, {
    signal: controller.signal,
  });
  controller.abort();
  await vi.advanceTimersByTimeAsync(0);
  return {
    watcher,
    flush: async (
      payload: Record<string, unknown>,
      request = 'example-request',
    ) => {
      fs.writeFileSync(
        path.join(dir, ipcOutputFileName(request)),
        JSON.stringify(payload),
      );
      watcher.notify();
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

function lateReply(tokenUsage: unknown = usage) {
  return {
    status: 'success',
    result: 'late success',
    toolsUsed: ['bash'],
    tokenUsage,
    sideEffects: { delegations: [{ action: 'delegate', prompt: 'example' }] },
    approvalReply: {
      decision: 'approve',
      approvalId: 'example-approval',
      scope: 'once',
    },
    pendingApproval: {
      approvalId: 'example-approval',
      prompt: 'example',
      intent: 'example',
      reason: 'example',
      allowSession: false,
      allowAgent: false,
      allowAll: false,
      expiresAt: null,
    },
  };
}

it.each(['missing', 'older', 'unreadable'] as const)(
  'keeps validated IPC usage when checkpoint state is %s',
  async (checkpoint) => {
    const { recoverWorkerOutput } = await import(
      '../src/infra/worker-recovery.js'
    );
    const workspace = temp();
    if (checkpoint !== 'missing') {
      const journal = new TurnCheckpoint(
        workspace,
        'example-session',
        'example-turn',
      );
      journal.usage({
        ...usage,
        apiPromptTokens: 60,
        apiCompletionTokens: 6,
        apiTotalTokens: 66,
        performanceSamples: [],
      });
      if (checkpoint === 'unreadable')
        fs.writeFileSync(turnCheckpointPath(workspace, 'example-session'), '{');
    }
    const { flush, watcher } = await interruptedRead();
    await flush(lateReply());
    const output = await pending;
    expect(output?.status).toBe('error');
    expect(output?.result).toBeNull();
    expect(output?.toolsUsed).toEqual([]);
    for (const key of ['sideEffects', 'pendingApproval', 'approvalReply'])
      expect(output).not.toHaveProperty(key);
    if (!output) throw new Error('Missing output');
    const recovered = recoverWorkerOutput(
      output,
      workspace,
      'example-session',
      'example-turn',
      true,
    );
    expect(recovered.tokenUsage).toEqual(usage);
    expect(recovered.status).toBe('error');
    expect(recovered.result).toBeNull();
    expect(watcher.watchers.every((watch) => watch.closed)).toBe(true);
  },
);

it('does not invent usage when no reply arrives during shutdown', async () => {
  const { watcher } = await interruptedRead();
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(pending).resolves.not.toHaveProperty('tokenUsage');
  expect(watcher.watchers.every((watch) => watch.closed)).toBe(true);
});

it('rejects malformed usage in a late reply', async () => {
  const { flush } = await interruptedRead();
  await flush(lateReply({ ...usage, apiPromptTokens: -1 }));
  await expect(pending).resolves.toMatchObject({
    status: 'error',
    result: null,
  });
  await expect(pending).resolves.not.toHaveProperty('tokenUsage');
});

it("does not attribute a different request's usage to the interrupted turn", async () => {
  const { flush } = await interruptedRead();
  await flush(lateReply(), 'other-request');
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(pending).resolves.not.toHaveProperty('tokenUsage');
});
