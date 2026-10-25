import fs from 'node:fs';
import { expect, test, vi } from 'vitest';
import type { McpClientManager } from '../container/src/mcp/client-manager.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('tool-call-limits-');
useCleanMocks({
  unstubAllEnvs: true,
  resetModules: true,
  restoreAllMocks: true,
});

async function startWorker(
  workspace = makeTempDir(),
  runId = 'run-1',
  limit = 12,
) {
  vi.resetModules();
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspace);
  const budget = await import('../container/src/tool-call-limits.js');
  const tools = await import('../container/src/tools.js');
  const call = vi.fn(async () => ({ output: 'written', isError: false }));
  tools.setMcpClientManager({
    isKnownTool: () => true,
    callToolDetailed: call,
  } as unknown as McpClientManager);
  budget.setToolCallLimits({
    sessionId: 'session-1',
    runId,
    toolCallLimits: { example__write: limit },
  });
  const { sessionStatePath, sessionStateKey } = await import(
    '../container/src/session-state.js'
  );
  const filePath = sessionStatePath(
    'session-1',
    `tool-call-limits-${sessionStateKey(runId)}.json`,
  );
  return { budget, tools, call, filePath, workspace };
}

test('rejects a thirteenth parallel write before the MCP side effect, without progress callbacks', async () => {
  const { tools, call } = await startWorker();
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      tools.executeToolWithMetadata('example__write', '{}'),
    ),
  );
  expect(call).toHaveBeenCalledTimes(12);
  expect(results.filter((result) => result.isError)).toHaveLength(8);
  expect(results[12].output).toContain('Tool call limit reached');
  expect(
    (await tools.executeToolWithMetadata('example__read', '{}')).isError,
  ).toBe(false);
});

test('replacement workers inherit counts; separate runs and sessions do not', async () => {
  const first = await startWorker(undefined, 'run-1', 1);
  await first.tools.executeToolWithMetadata('example__write', '{}');
  const replacement = await startWorker(first.workspace, 'run-1', 1);
  expect(
    (await replacement.tools.executeToolWithMetadata('example__write', '{}'))
      .isError,
  ).toBe(true);
  expect(replacement.call).not.toHaveBeenCalled();
  const nextRun = await startWorker(first.workspace, 'run-2', 1);
  expect(
    (await nextRun.tools.executeToolWithMetadata('example__write', '{}'))
      .isError,
  ).toBe(false);
  nextRun.budget.setToolCallLimits({
    sessionId: 'other',
    runId: 'run-2',
    toolCallLimits: { example__write: 1 },
  });
  expect(
    (await nextRun.tools.executeToolWithMetadata('example__write', '{}'))
      .isError,
  ).toBe(false);
});

test.each(['corrupt', 'negative', 'missing', 'unwritable'])(
  '%s persisted state fails closed before execution',
  async (fault) => {
    const { filePath, tools, call } = await startWorker();
    if (fault === 'corrupt') fs.writeFileSync(filePath, '{');
    if (fault === 'negative')
      fs.writeFileSync(filePath, '{"example__write":-1}');
    if (fault === 'missing' || fault === 'unwritable') fs.unlinkSync(filePath);
    if (fault === 'unwritable') fs.mkdirSync(filePath);
    expect(
      (await tools.executeToolWithMetadata('example__write', '{}')).isError,
    ).toBe(true);
    expect(call).not.toHaveBeenCalled();
  },
);

test('failed executions consume their reservation and unbudgeted turns clear active limits', async () => {
  const { tools, budget, call } = await startWorker(undefined, 'run-1', 1);
  call.mockRejectedValueOnce(new Error('connection lost after submission'));
  expect(
    (await tools.executeToolWithMetadata('example__write', '{}')).isError,
  ).toBe(true);
  expect(
    (await tools.executeToolWithMetadata('example__write', '{}')).isError,
  ).toBe(true);
  expect(call).toHaveBeenCalledTimes(1);
  budget.setToolCallLimits({ sessionId: 'session-1' });
  expect(
    (await tools.executeToolWithMetadata('example__write', '{}')).isError,
  ).toBe(false);
});

test('a failed reservation write blocks the side effect and the state path is protected', async () => {
  const { tools, call, filePath } = await startWorker();
  const { matchesApprovalStatePath } = await import(
    '../container/src/approval-state-guard.js'
  );
  expect(matchesApprovalStatePath(filePath)).toBe(true);
  vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
    throw new Error('disk failure');
  });
  expect(
    (await tools.executeToolWithMetadata('example__write', '{}')).isError,
  ).toBe(true);
  expect(call).not.toHaveBeenCalled();
});

test.each([-1, 1.5, Infinity, NaN])(
  'rejects invalid limit %s',
  async (limit) => {
    await expect(startWorker(undefined, 'run-1', limit)).rejects.toThrow(
      'nonnegative integers',
    );
  },
);

test('zero forbids execution and a budget requires a stable run ID', async () => {
  const { tools, budget, call } = await startWorker(undefined, 'run-1', 0);
  expect(
    (await tools.executeToolWithMetadata('example__write', '{}')).isError,
  ).toBe(true);
  expect(call).not.toHaveBeenCalled();
  expect(() =>
    budget.setToolCallLimits({
      sessionId: 's',
      toolCallLimits: { example__write: 1 },
    }),
  ).toThrow('run ID');
});
