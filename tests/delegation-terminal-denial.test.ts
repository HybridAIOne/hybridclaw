import path from 'node:path';
import { expect, test, vi } from 'vitest';
import type { ContainerOutput } from '../src/types/container.js';
import type { ToolExecution } from '../src/types/execution.js';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock, stopMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
  stopMock: vi.fn(),
}));
vi.mock('../src/agent/agent.js', () => ({ runAgent: runAgentMock }));
vi.mock('../src/infra/host-runner.js', () => ({
  stopSessionHostProcess: stopMock,
}));
const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'terminal-delegation-denial-',
  cleanup: () => {
    runAgentMock.mockReset();
    stopMock.mockReset();
  },
});
const denial: ToolExecution = {
  name: 'write',
  arguments: '{"path":"report.md"}',
  result: 'Fixture policy refusal.',
  durationMs: 0,
  isError: true,
  blocked: true,
  approvalDecision: 'denied',
  escalationRoute: 'policy_denial',
  approvalReason: 'Fixture existing file is unrelated.',
};
const terminal: ContainerOutput = {
  status: 'success',
  result: 'Fixture policy refusal.',
  toolsUsed: ['read'],
  toolExecutions: [denial],
  outputPresentation: {
    segmentKind: 'status',
    visible: true,
    displaySurface: 'assistant_bubble',
  },
};

test.each([
  { name: 'terminal policy denial', output: terminal, expected: 'blocked' },
  {
    name: 'recovered denial with default presentation',
    output: {
      ...terminal,
      outputPresentation: undefined,
      result: 'Completed permitted work.',
    },
    expected: 'completed',
  },
  {
    name: 'status after an earlier recovered denial',
    output: {
      ...terminal,
      toolExecutions: [
        denial,
        {
          name: 'read',
          arguments: '{}',
          result: 'Read fixture.',
          durationMs: 1,
          isError: false,
        },
      ],
    },
    expected: 'completed',
  },
  {
    name: 'recovered denial with no further tools',
    output: {
      ...terminal,
      result: 'Completed the permitted report.',
      outputPresentation: {
        ...terminal.outputPresentation!,
        segmentKind: 'final' as const,
      },
    },
    expected: 'completed',
  },
  {
    name: 'recovered denial followed by a successful tool',
    output: {
      ...terminal,
      result: 'Completed the separate report.',
      outputPresentation: {
        ...terminal.outputPresentation!,
        segmentKind: 'final' as const,
      },
      toolExecutions: [
        denial,
        {
          name: 'write',
          arguments: '{"path":"separate.md"}',
          result: 'Created fixture.',
          durationMs: 1,
          isError: false,
        },
      ],
    },
    expected: 'completed',
  },
  {
    name: 'a status with an ordinary tool error',
    output: {
      ...terminal,
      toolExecutions: [
        {
          name: 'read',
          arguments: '{"path":"missing.md"}',
          result: 'Missing fixture.',
          durationMs: 1,
          isError: true,
        },
      ],
    },
    expected: 'completed',
  },
  {
    name: 'ordinary prose mentioning a block',
    output: {
      status: 'success' as const,
      result: 'The report describes blocked requests.',
      toolsUsed: [],
    },
    expected: 'completed',
  },
  {
    name: 'pending human approval',
    output: {
      ...terminal,
      toolExecutions: [],
      pendingApproval: {
        approvalId: 'fixture-approval',
        prompt: 'Approve fixture?',
        intent: 'write a fixture',
        reason: 'Human consent required.',
        toolName: 'write',
        allowSession: false,
        allowAgent: false,
        allowAll: false,
        expiresAt: null,
      },
    },
    expected: 'blocked',
  },
])('$name is reported as $expected', async ({ output, expected }) => {
  const home = setupHome();
  const db = await import('../src/memory/db.js');
  db.initDatabase({ quiet: true, dbPath: path.join(home, 'history.db') });
  db.getOrCreateSession('parent', null, 'web', 'main');
  runAgentMock.mockResolvedValue(output);
  const { runDelegationTaskWithRetry } = await import(
    '../src/gateway/delegation-child-run.js'
  );
  const report = await runDelegationTaskWithRetry({
    parentSessionId: 'parent',
    childDepth: 1,
    channelId: 'web',
    chatbotId: '',
    enableRag: false,
    agentId: 'main',
    mode: 'single',
    task: { prompt: 'Create a fixture report.', model: 'test-model' },
  });
  expect(report.status).toBe(expected);
  expect(report.attempts).toBe(1);
  expect(runAgentMock).toHaveBeenCalledTimes(1);
  expect(stopMock).toHaveBeenCalledOnce();
  if (expected === 'blocked') {
    expect(report.result).toBeUndefined();
    expect(report.error).toBeTruthy();
    expect(report.toolExecutions).toEqual(output.toolExecutions);
  } else expect(report.result).toBe(output.result);
});
