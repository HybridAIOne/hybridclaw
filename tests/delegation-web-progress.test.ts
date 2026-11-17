import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import type { ToolProgressEvent } from '../src/types/execution.js';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgent } = vi.hoisted(() => ({ runAgent: vi.fn() }));
vi.mock('../src/agent/agent.js', () => ({ runAgent }));
vi.mock('../src/infra/host-runner.js', () => ({
  stopSessionHostProcess: vi.fn(),
}));
const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-delegate-progress-',
  cleanup: () => {
    runAgent.mockReset();
  },
});

async function setup() {
  const home = setupHome();
  const db = await import('../src/memory/db.js');
  db.initDatabase({ quiet: true, dbPath: path.join(home, 'history.db') });
  db.getOrCreateSession('parent', null, 'web', 'main');
  db.getOrCreateSession('other', null, 'web', 'main');
  db.createDelegationJob({
    publicId: 'job_a',
    internalId: 'internal_a',
    parentSessionId: 'parent',
    channelId: 'web',
    agentId: 'main',
    taskCount: 1,
  });
  const progress = await import('../src/gateway/delegation-web-progress.js');
  const store = await import('../src/gateway/web-notification-store.js');
  const notifications = await import('../src/gateway/web-notifications.js');
  const operator = store.notificationOperatorId('user_a');
  const otherOperator = store.notificationOperatorId('user_b');
  store.bindWebNotificationSession('parent', operator);
  store.bindWebNotificationSession('other', otherOperator);
  const response = () =>
    Object.assign(new EventEmitter(), {
      writeHead: vi.fn(),
      write: vi.fn(),
      destroyed: false,
      writableEnded: false,
    });
  return {
    db,
    progress,
    store,
    notifications,
    operator,
    otherOperator,
    response,
  };
}

test('background child calls update one durable progress message while the job runs', async () => {
  const { db, store, operator } = await setup();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  runAgent.mockImplementation(
    async (params: {
      sessionId: string;
      onToolProgress: (event: ToolProgressEvent) => void;
    }) => {
      const event = {
        sessionId: params.sessionId,
        toolName: 'web_search',
        toolCallId: 'search_1',
      };
      params.onToolProgress({
        ...event,
        phase: 'start',
        preview: '{"query":"example terrain data"}',
      });
      started.resolve();
      await release.promise;
      params.onToolProgress({
        ...event,
        phase: 'finish',
        preview: 'Found two sources',
        durationMs: 25,
      });
      return {
        status: 'success',
        result: 'Research complete',
        toolsUsed: ['web_search'],
      };
    },
  );
  const { enqueueDelegationBatchFromSideEffects } = await import(
    '../src/gateway/gateway-delegation.js'
  );
  const job = enqueueDelegationBatchFromSideEffects({
    plans: [
      {
        mode: 'single',
        tasks: [
          {
            label: 'Inspect terrain',
            prompt: 'Inspect example terrain data',
            model: 'test-model',
          },
        ],
      },
    ],
    parentSessionId: 'parent',
    channelId: 'web',
    chatbotId: 'test-bot',
    enableRag: false,
    agentId: 'main',
    parentDepth: 0,
    runParentTurn: async () => ({
      status: 'success',
      result: 'Finished research',
    }),
  });
  expect(job).not.toBeNull();
  try {
    await started.promise;
    await vi.waitFor(() => {
      const history = db.getConversationHistoryPage('parent').history;
      expect(history).toHaveLength(1);
      expect(history[0]?.content).toContain('web_search');
      expect(history[0]?.activityTrace?.steps).toContainEqual(
        expect.objectContaining({
          kind: 'tool',
          toolName: 'web_search',
          argsPreview: '{"query":"example terrain data"}',
        }),
      );
    });
    expect(store.readWebNotificationState(operator).notifications).toHaveLength(
      0,
    );
  } finally {
    release.resolve();
    await vi.waitFor(() =>
      expect(db.getDelegationJob(job!.publicId)?.status).toBe('completed'),
    );
  }
  const history = db.getConversationHistoryPage('parent').history;
  expect(history).toHaveLength(1);
  expect(history[0]?.activityTrace?.steps).toContainEqual(
    expect.objectContaining({
      kind: 'tool',
      toolName: 'web_search',
      resultPreview: 'Found two sources',
      durationMs: 25,
    }),
  );
});

test('progress signals reach only the owning operator and never create unread alerts', async () => {
  const { progress, store, notifications, operator, otherOperator, response } =
    await setup();
  const own = response();
  const other = response();
  notifications.streamWebNotifications(
    operator,
    own as unknown as ServerResponse,
  );
  notifications.streamWebNotifications(
    otherOperator,
    other as unknown as ServerResponse,
  );
  own.write.mockClear();
  other.write.mockClear();
  try {
    progress
      .createDelegationWebProgress({
        jobId: 'job_a',
        sessionId: 'parent',
        agentId: 'main',
      })
      .update('Running');
    notifications.broadcastWebChatUpdate('unowned');
    expect(own.write).toHaveBeenCalledExactlyOnceWith(
      'event: chat-updated\ndata: {"sessionId":"parent"}\n\n',
    );
    expect(other.write).not.toHaveBeenCalled();
    expect(store.readWebNotificationState(operator).notifications).toHaveLength(
      0,
    );
  } finally {
    own.emit('close');
    other.emit('close');
  }
});

test('parallel same-name tools keep their previews paired and redact credentials', async () => {
  const { db, progress } = await setup();
  const writer = progress.createDelegationWebProgress({
    jobId: 'job_a',
    sessionId: 'parent',
    agentId: 'main',
  });
  const event = { toolName: 'web_fetch', toolCallId: 'call_1' };
  writer.recordTool(
    {
      ...event,
      sessionId: 'child_a',
      phase: 'start',
      preview: 'Authorization: Bearer test-secret-token',
    },
    'First task',
  );
  writer.recordTool(
    {
      ...event,
      sessionId: 'child_b',
      phase: 'start',
      preview: 'https://example.com',
    },
    'Second task',
  );
  writer.recordTool(
    {
      ...event,
      sessionId: 'child_a',
      phase: 'finish',
      preview: 'First result',
      durationMs: 10,
    },
    'First task',
  );
  writer.recordTool(
    {
      ...event,
      sessionId: 'child_b',
      phase: 'finish',
      preview: 'Second result',
      durationMs: 20,
    },
    'Second task',
  );
  writer.update('Finished');
  const history = db.getConversationHistoryPage('parent').history;
  const tools = history[0]?.activityTrace?.steps.filter(
    (step) => step.kind === 'tool',
  );
  expect(tools).toMatchObject([
    { resultPreview: 'First result', durationMs: 10 },
    {
      argsPreview: 'https://example.com',
      resultPreview: 'Second result',
      durationMs: 20,
    },
  ]);
  expect(JSON.stringify(history)).not.toContain('test-secret-token');
  expect(db.getConversationHistoryPage('other').history).toHaveLength(0);
});

test.each(['reset', 'deleted'] as const)(
  'late progress cannot recreate a %s parent',
  async (state) => {
    const { db, progress } = await setup();
    const { withMemoryDatabase } = await import('../src/memory/database.js');
    withMemoryDatabase((database) =>
      database
        .prepare(
          state === 'reset'
            ? 'UPDATE sessions SET is_current = 0 WHERE id = ?'
            : 'DELETE FROM sessions WHERE id = ?',
        )
        .run('parent'),
    );
    progress
      .createDelegationWebProgress({
        jobId: 'job_a',
        sessionId: 'parent',
        agentId: 'main',
      })
      .update('Running');
    expect(db.getConversationHistoryPage('parent').history).toHaveLength(0);
  },
);

test.each(['failed', 'restart'] as const)(
  '%s work stops showing a running progress message',
  async (mode) => {
    const { db, progress } = await setup();
    const writer = progress.createDelegationWebProgress({
      jobId: 'job_a',
      sessionId: 'parent',
      agentId: 'main',
    });
    writer.recordTool(
      {
        sessionId: 'child_a',
        toolName: 'web_search',
        phase: 'finish',
        preview: 'Partial result',
      },
      'Research',
    );
    writer.update('Running');
    if (mode === 'restart') db.failStaleDelegationJobs('gateway_restart');
    else db.failDelegationJob('job_a', 'failed');
    writer.update('Running');
    const message = db.getConversationHistoryPage('parent').history[0];
    expect(message?.content).not.toContain('Running');
    expect(message?.activityTrace?.steps).toContainEqual(
      expect.objectContaining({
        toolName: 'web_search',
        resultPreview: 'Partial result',
      }),
    );
    expect(message?.activityTrace?.running).not.toBe(true);
  },
);

test('waiting delegates retain their deadline while streaming distinct sibling calls', async () => {
  await setup();
  const { registerActiveGatewayRequest } = await import(
    '../src/gateway/gateway-request-runtime.js'
  );
  const { runDelegationNow } = await import(
    '../src/gateway/gateway-delegation.js'
  );
  const onToolProgress = vi.fn();
  const executionDeadlineAtMs = Date.now() + 60_000;
  const request = registerActiveGatewayRequest({
    sessionId: 'parent',
    executionSessionId: 'worker',
    onToolProgress,
    executionDeadlineAtMs,
  });
  runAgent.mockImplementation(
    async (params: {
      sessionId: string;
      onToolProgress: (event: ToolProgressEvent) => void;
    }) => {
      params.onToolProgress({
        sessionId: params.sessionId,
        toolName: 'web_search',
        toolCallId: 'call_1',
        phase: 'start',
      });
      params.onToolProgress({
        sessionId: params.sessionId,
        toolName: 'web_search',
        toolCallId: 'call_1',
        phase: 'finish',
        durationMs: 10,
      });
      return {
        status: 'success',
        result: 'Research complete',
        toolsUsed: ['web_search'],
      };
    },
  );
  try {
    await runDelegationNow({
      sessionId: 'worker',
      effect: {
        action: 'delegate',
        mode: 'parallel',
        tasks: [
          { prompt: 'Inspect first source' },
          { prompt: 'Inspect second source' },
        ],
      },
    });
    expect(onToolProgress).toHaveBeenCalledTimes(4);
    const starts = onToolProgress.mock.calls
      .map(([event]) => event as ToolProgressEvent)
      .filter((event) => event.phase === 'start');
    expect(starts.every((event) => event.sessionId === 'parent')).toBe(true);
    expect(new Set(starts.map((event) => event.toolCallId)).size).toBe(2);
    expect(
      runAgent.mock.calls.every(
        ([params]) => params.executionDeadlineAtMs === executionDeadlineAtMs,
      ),
    ).toBe(true);
  } finally {
    request.release();
  }
});

test.each(['released', 'aborted'] as const)(
  'a %s parent no longer accepts child progress',
  async (state) => {
    await setup();
    const runtime = await import('../src/gateway/gateway-request-runtime.js');
    const onToolProgress = vi.fn();
    const request = runtime.registerActiveGatewayRequest({
      sessionId: 'parent',
      onToolProgress,
    });
    const callback =
      runtime.resolveGatewayRequestContext('parent')?.onToolProgress;
    try {
      if (state === 'released') request.release();
      else runtime.abortActiveGatewayRequests('parent');
      callback?.({
        sessionId: 'child_a',
        toolName: 'web_search',
        phase: 'start',
      });
      expect(onToolProgress).not.toHaveBeenCalled();
    } finally {
      request.release();
    }
  },
);

test('hidden tools do not leak through background progress', async () => {
  const { db, progress } = await setup();
  const { withMemoryDatabase } = await import('../src/memory/database.js');
  withMemoryDatabase((database) =>
    database
      .prepare('UPDATE sessions SET show_mode = ? WHERE id = ?')
      .run('none', 'parent'),
  );
  const writer = progress.createDelegationWebProgress({
    jobId: 'job_a',
    sessionId: 'parent',
    agentId: 'main',
  });
  writer.recordTool(
    {
      sessionId: 'child_a',
      toolName: 'web_search',
      phase: 'start',
      preview: 'private search terms',
    },
    'Research',
  );
  writer.update('web_search private search terms');
  const history = db.getConversationHistoryPage('parent').history;
  expect(history[0]?.activityTrace).toBeUndefined();
  expect(JSON.stringify(history)).not.toContain('private search terms');
  expect(JSON.stringify(history)).not.toContain('web_search');
});

test('progress storage failures do not change the execution lifecycle', async () => {
  const { db, progress } = await setup();
  const storage = await import('../src/memory/delegation-progress.js');
  vi.spyOn(storage, 'storeDelegationProgress').mockImplementation(() => {
    throw new Error('storage unavailable');
  });
  const writer = progress.createDelegationWebProgress({
    jobId: 'job_a',
    sessionId: 'parent',
    agentId: 'main',
  });
  expect(() => writer.update('Running')).not.toThrow();
  expect(db.getDelegationJob('job_a')?.status).toBe('queued');
  expect(runAgent).not.toHaveBeenCalled();
});
