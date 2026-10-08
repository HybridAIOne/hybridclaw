import path from 'node:path';
import { expect, test, vi } from 'vitest';
import type { ToolProgressEvent } from '../src/types/execution.ts';
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

const makeTempHome = useTempDir('hybridclaw-delegation-retry-');

useCleanMocks({
  resetModules: true,
  unstubAllEnvs: true,
  cleanup: () => {
    runAgentMock.mockReset();
    stopSessionHostProcessMock.mockReset();
  },
});

type ChildRunParams = {
  onToolProgress?: (event: ToolProgressEvent) => void;
};

// A host-built crash output: no toolExecutions, and "532ms" reads as a 5xx,
// so classifyGatewayError calls it transient.
const CRASH_AFTER_WRITE =
  'Container exited before producing output (exit code 1). [tool] write result (532ms): wrote notes.txt';

function reportWrite(params: ChildRunParams): void {
  params.onToolProgress?.({
    sessionId: 'delegate-child',
    toolName: 'write',
    phase: 'start',
    preview: 'notes.txt',
  });
  params.onToolProgress?.({
    sessionId: 'delegate-child',
    toolName: 'write',
    phase: 'finish',
    durationMs: 532,
    preview: 'wrote notes.txt',
  });
}

async function runSingleDelegation(): Promise<string> {
  const homeDir = makeTempHome();
  vi.stubEnv('HOME', homeDir);
  const { enqueueDelegationBatchFromSideEffects } = await import(
    '../src/gateway/gateway-delegation.ts'
  );
  const { getDelegationJob, getOrCreateSession, initDatabase } = await import(
    '../src/memory/db.ts'
  );
  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  const { flushAuditTrail } = await import('../src/audit/audit-trail.ts');
  initDatabase({ quiet: true, dbPath: path.join(homeDir, 'hybridclaw.db') });
  getOrCreateSession('retry-parent-session', null, 'tui', 'test-agent');
  updateRuntimeConfig((draft) => {
    draft.proactive.autoRetry.baseDelayMs = 100;
    draft.proactive.autoRetry.maxDelayMs = 100;
  });

  const descriptor = enqueueDelegationBatchFromSideEffects({
    plans: [
      {
        mode: 'single',
        label: 'write-notes',
        tasks: [
          {
            prompt: 'Write the notes file.',
            label: 'write-notes',
            model: 'test-model',
          },
        ],
      },
    ],
    parentSessionId: 'retry-parent-session',
    channelId: 'tui',
    chatbotId: 'test-bot',
    enableRag: false,
    agentId: 'test-agent',
    parentModel: 'orchestrator-model',
    parentDepth: 0,
    runParentTurn: async ({ content }) => ({
      status: 'success',
      result: `parent read: ${content.length} chars`,
    }),
  });
  const publicId = descriptor?.publicId || '';
  try {
    await vi.waitFor(
      () => expect(getDelegationJob(publicId)?.status).toBe('completed'),
      { timeout: 5_000 },
    );
  } finally {
    // A child's tool executions are audited in the background and can still
    // be writing under the temp home when the job completes.
    await flushAuditTrail();
  }
  return getDelegationJob(publicId)?.result_digest || '';
}

test.each([
  [
    'returned a crash after reporting a tool',
    async (params: ChildRunParams) => {
      reportWrite(params);
      return {
        status: 'error',
        result: null,
        toolsUsed: [],
        error: CRASH_AFTER_WRITE,
      };
    },
  ],
  [
    'threw after reporting a tool',
    async (params: ChildRunParams) => {
      reportWrite(params);
      throw new Error('socket hang up');
    },
  ],
  [
    'returned tool executions with a timeout',
    async () => ({
      status: 'error',
      result: null,
      toolsUsed: ['write'],
      toolExecutions: [
        {
          name: 'write',
          arguments: '{"path":"notes.txt"}',
          result: 'wrote notes.txt',
          durationMs: 5,
        },
      ],
      error: 'Timeout waiting for agent output after 300000ms',
    }),
  ],
])('a delegate child that %s is final, not re-run', async (_label, child) => {
  runAgentMock.mockImplementation(child);

  const digest = await runSingleDelegation();

  expect(runAgentMock).toHaveBeenCalledTimes(1);
  expect(digest).toMatch(/^attempts: 1$/m);
  expect(digest).toMatch(/^status: (?:failed|timeout)$/m);
});

test('a delegate child that failed transiently before any tool ran is retried', async () => {
  runAgentMock
    .mockResolvedValueOnce({
      status: 'error',
      result: null,
      toolsUsed: [],
      error: 'fetch failed',
    })
    .mockResolvedValueOnce({
      status: 'success',
      result: 'notes written',
      toolsUsed: [],
    });

  const digest = await runSingleDelegation();

  expect(runAgentMock).toHaveBeenCalledTimes(2);
  expect(digest).toMatch(/^attempts: 2$/m);
  expect(digest).toMatch(/^status: completed$/m);
});
