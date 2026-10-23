import path from 'node:path';
import { expect, test, vi } from 'vitest';
import type { PendingApproval } from '../src/types/execution.ts';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const { runAgentMock, stopSessionHostProcessMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
  stopSessionHostProcessMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

vi.mock('../src/infra/host-runner.js', () => ({
  stopSessionHostProcess: stopSessionHostProcessMock,
}));

const makeTempHome = useTempDir('hybridclaw-delegation-approval-');

useCleanMocks({
  resetModules: true,
  unstubAllEnvs: true,
  cleanup: () => {
    runAgentMock.mockReset();
    stopSessionHostProcessMock.mockReset();
  },
});

const PARENT_APPROVAL: PendingApproval = {
  approvalId: 'appr-1',
  prompt: 'I need your approval before I run create_file.',
  intent: 'create a file',
  reason: 'the tool writes outside the sandbox',
  toolName: 'create_file',
  allowSession: true,
  allowAgent: true,
  allowAll: true,
  expiresAt: null,
};

test.each([
  ['an approval prompt carries the approval', PARENT_APPROVAL, 'appr-1'],
  ['a plain reply carries no approval', undefined, undefined],
])('delegation parent turn: %s to the channel', async (_name, pendingApproval, expectedId) => {
  const homeDir = makeTempHome();
  vi.stubEnv('HOME', homeDir);
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'child summary',
    toolsUsed: [],
    artifacts: [],
  });
  const { enqueueDelegationBatchFromSideEffects } = await import(
    '../src/gateway/gateway-delegation.ts'
  );
  const { getDelegationJob, getOrCreateSession, initDatabase } = await import(
    '../src/memory/db.ts'
  );
  initDatabase({ quiet: true, dbPath: path.join(homeDir, 'hybridclaw.db') });
  getOrCreateSession('approval-parent', null, 'channel-1', 'test-agent');

  const onProactiveMessage = vi.fn();
  const descriptor = enqueueDelegationBatchFromSideEffects({
    plans: [
      {
        mode: 'single',
        label: 'write-file',
        tasks: [
          { prompt: 'Write the file.', label: 'write-file', model: 'm' },
        ],
      },
    ],
    parentSessionId: 'approval-parent',
    channelId: 'channel-1',
    chatbotId: 'test-bot',
    enableRag: false,
    agentId: 'test-agent',
    parentModel: 'orchestrator-model',
    parentDepth: 0,
    onProactiveMessage,
    runParentTurn: async () => ({
      status: 'success',
      result: 'parent reply',
      pendingApproval,
    }),
  });

  await vi.waitFor(() =>
    expect(getDelegationJob(descriptor?.publicId || '')?.status).toBe(
      'completed',
    ),
  );
  const final = onProactiveMessage.mock.calls
    .map(([message]) => message)
    .find((message) => message.text === 'parent reply');
  expect(final?.approval?.approvalId).toBe(expectedId);
});
