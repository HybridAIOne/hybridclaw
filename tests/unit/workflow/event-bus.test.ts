import { afterEach, expect, test, vi } from 'vitest';

import {
  doesWorkflowTriggerMatchEvent,
  publishWorkflowEvent,
  resetWorkflowEventBus,
  setWorkflowEventExecutor,
  upsertWorkflowEventSubscription,
} from '../../../src/workflow/event-bus.js';
import type { StoredWorkflow } from '../../../src/workflow/types.js';

function buildWorkflow(overrides?: Partial<StoredWorkflow>): StoredWorkflow {
  return {
    id: 1,
    session_id: 'session-1',
    agent_id: 'agent-1',
    channel_id: 'channel-1',
    name: 'Test Workflow',
    description: '',
    natural_language: 'When someone says deploy, notify me.',
    enabled: 1,
    companion_task_id: null,
    last_run: null,
    last_status: null,
    consecutive_errors: 0,
    run_count: 0,
    created_at: '2026-03-16 09:00:00',
    updated_at: '2026-03-16 09:00:00',
    spec: {
      version: 2,
      trigger: {
        kind: 'channel_event',
        sourceChannel: 'discord',
        eventType: 'message',
        contentPattern: 'deploy',
      },
      steps: [
        {
          id: 'notify',
          kind: 'agent',
          prompt: 'Notify the operator.',
        },
      ],
      delivery: {
        kind: 'originating',
      },
    },
    ...overrides,
  };
}

afterEach(() => {
  resetWorkflowEventBus();
});

test('matches regex-based channel event triggers', () => {
  const matched = doesWorkflowTriggerMatchEvent(
    {
      kind: 'channel_event',
      sourceChannel: 'discord',
      eventType: 'message',
      contentPattern: 'deploy',
      fromPattern: '^user',
    },
    {
      kind: 'message',
      sourceChannel: 'discord',
      channelId: '123',
      senderId: 'user-17',
      content: 'deploy the hotfix',
      timestamp: Date.now(),
    },
  );

  expect(matched).toBe(true);
});

test('matches reaction triggers by emoji', () => {
  expect(
    doesWorkflowTriggerMatchEvent(
      {
        kind: 'reaction',
        sourceChannel: 'discord',
        reactionEmoji: 'OK',
      },
      {
        kind: 'reaction',
        sourceChannel: 'discord',
        channelId: '123',
        senderId: 'user-1',
        reactionEmoji: 'OK',
        timestamp: Date.now(),
      },
    ),
  ).toBe(true);
});

test('publishes matching events to the registered executor', async () => {
  const executor = vi.fn(async () => {});
  setWorkflowEventExecutor(executor);
  upsertWorkflowEventSubscription(buildWorkflow());

  const matchedIds = await publishWorkflowEvent({
    kind: 'message',
    sourceChannel: 'discord',
    channelId: 'channel-1',
    senderId: 'user-2',
    content: 'please deploy now',
    timestamp: Date.now(),
  });

  expect(matchedIds).toEqual([1]);
  expect(executor).toHaveBeenCalledWith({
    workflowId: 1,
    event: expect.objectContaining({
      kind: 'message',
      sourceChannel: 'discord',
      content: 'please deploy now',
    }),
    agentId: 'agent-1',
    sessionId: 'session-1',
  });
});
