import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const temporary = useTempDir('file-conflict-replan-');
useCleanMocks({ unstubAllEnvs: true, resetModules: true });
beforeEach(() => {
  const root = temporary();
  vi.stubEnv('HOME', root);
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', root);
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', root);
  vi.stubEnv('HYBRIDCLAW_AGENT_STATE_ROOT', path.join(root, 'state'));
});

const mutation = {
  toolName: 'bash',
  argsJson: JSON.stringify({ command: 'cp report.md backup.md' }),
};
async function setup(mode: 'full' | 'ask' = 'full', conflict = true) {
  const { approvalRuntime, createToolApprovalResolver } = await import(
    '../container/src/tool-approval.js'
  );
  const state = await import('../container/src/file-write-conflicts.js');
  approvalRuntime.setSession('replan');
  approvalRuntime.setApprovalMode({ mode });
  if (conflict) await state.recordFileWriteConflict('replan', 'report.md');
  const resolve = createToolApprovalResolver({
    sessionId: 'replan',
    latestUserPrompt: 'Create new release notes.',
    channelId: 'web',
    fallbackContext: {
      provider: 'vllm',
      baseUrl: 'http://example.com/v1',
      apiKey: 'test-key',
      model: 'example/model',
      chatbotId: '',
    },
  });
  return { resolve, approvalRuntime, state };
}

test('full-auto offers one blocked recovery without creating pending approval', async () => {
  const { resolve, approvalRuntime, state } = await setup();
  const first = await resolve(mutation);
  expect(first).toMatchObject({
    decision: 'denied',
    pinned: true,
    writeIntent: true,
  });
  expect(first.requestId).toBeUndefined();
  expect(approvalRuntime.getPendingApprovals()).toEqual([]);
  expect(state.getFileWriteConflict('replan', 'report.md')).toBeTruthy();
  const second = await resolve(mutation);
  expect(second).toMatchObject({ decision: 'required', pinned: true });
  expect(second.requestId).toBeTruthy();
  expect(approvalRuntime.getPendingApprovals()).toHaveLength(1);
});

test('changing the command does not reset the per-turn recovery allowance', async () => {
  const { resolve, approvalRuntime } = await setup();
  expect((await resolve(mutation)).decision).toBe('denied');
  expect(
    (
      await resolve({
        toolName: 'bash',
        argsJson: JSON.stringify({ command: 'bash generated.sh' }),
      })
    ).decision,
  ).toBe('required');
  expect(approvalRuntime.getPendingApprovals()).toHaveLength(1);
});

test('ask mode still presents the first approval', async () => {
  const { resolve, approvalRuntime } = await setup('ask');
  expect((await resolve(mutation)).decision).toBe('required');
  expect(approvalRuntime.getPendingApprovals()).toHaveLength(1);
});

test('ordinary pinned paths keep their prompt and do not consume collision recovery', async () => {
  const { resolve, approvalRuntime, state } = await setup('full', false);
  expect(
    (
      await resolve({
        toolName: 'read',
        argsJson: JSON.stringify({ path: '.env' }),
      })
    ).decision,
  ).toBe('required');
  const pending = approvalRuntime.getPendingApprovals();
  await state.recordFileWriteConflict('replan', 'report.md');
  expect((await resolve(mutation)).decision).toBe('denied');
  expect(approvalRuntime.getPendingApprovals()).toEqual(pending);
});

test('read-only recovery does not consume the blocked-action allowance', async () => {
  const { resolve, approvalRuntime } = await setup();
  expect(
    (
      await resolve({
        toolName: 'bash',
        argsJson: JSON.stringify({ command: 'cat report.md' }),
      })
    ).decision,
  ).toBe('auto');
  expect((await resolve(mutation)).decision).toBe('denied');
  expect(approvalRuntime.getPendingApprovals()).toEqual([]);
});

test('one-time consent still authorizes exactly the requested operation', async () => {
  const { resolve, approvalRuntime } = await setup();
  await resolve(mutation);
  const requested = await resolve(mutation);
  approvalRuntime.resolveApprovalResponse({
    kind: 'approve',
    requestId: requested.requestId,
    mode: 'once',
  });
  expect((await resolve(mutation)).decision).toBe('approved_once');
  expect((await resolve(mutation)).decision).toBe('required');
});
