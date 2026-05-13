import os from 'node:os';
import path from 'node:path';
import { beforeEach, expect, test } from 'vitest';
import { handleGoalCommand } from '../src/goals/goal-command.js';
import {
  getThreadGoal,
  recordThreadGoalTurn,
  resumeThreadGoal,
  setThreadGoal,
  updateThreadGoalStatus,
} from '../src/goals/goal-manager.js';
import {
  clearScheduledGoalContinuation,
  isGoalInitialPromptScheduled,
} from '../src/goals/goal-runtime.js';
import { initDatabase } from '../src/memory/db.js';
import type { Session } from '../src/types/session.js';

function tempDbPath(): string {
  return path.join(
    os.tmpdir(),
    `hybridclaw-goal-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
  );
}

beforeEach(() => {
  initDatabase({ quiet: true, dbPath: tempDbPath() });
});

test('persists one thread goal and replaces it on set', () => {
  const first = setThreadGoal({
    threadId: 'thread-a',
    goalText: ' finish the report ',
    maxTurns: 12,
    setterActor: { type: 'user', id: 'user_a', name: 'User A' },
    targetAgentId: 'agent-a',
  });
  expect(first.status).toBe('active');
  expect(first.goalText).toBe('finish the report');
  expect(first.maxTurns).toBe(12);
  expect(first.setterActor).toEqual({
    type: 'user',
    id: 'user_a',
    name: 'User A',
  });

  const second = setThreadGoal({
    threadId: 'thread-a',
    goalText: 'ship the patch',
    maxTurns: 5,
    setterActor: { type: 'user', id: 'user_b' },
    targetAgentId: 'agent-b',
  });
  expect(second.goalText).toBe('ship the patch');
  expect(second.turnsUsed).toBe(0);
  expect(second.targetAgentId).toBe('agent-b');
  expect(getThreadGoal('thread-a')?.maxTurns).toBe(5);
});

test('tracks turn verdicts and pause/resume lifecycle', () => {
  setThreadGoal({
    threadId: 'thread-b',
    goalText: 'triage the queue',
    maxTurns: 3,
    setterActor: { type: 'user', id: 'user_a' },
    targetAgentId: 'agent-a',
  });

  const afterTurn = recordThreadGoalTurn({
    threadId: 'thread-b',
    verdict: 'active',
    reason: 'more work remains',
  });
  expect(afterTurn?.turnsUsed).toBe(1);
  expect(afterTurn?.lastVerdict).toBe('active');
  expect(afterTurn?.consecutiveParseFailures).toBe(0);

  const paused = updateThreadGoalStatus({
    threadId: 'thread-b',
    status: 'paused',
    reason: 'pending approval',
  });
  expect(paused?.status).toBe('paused');
  expect(paused?.pausedReason).toBe('pending approval');

  const resumed = resumeThreadGoal('thread-b');
  expect(resumed?.status).toBe('active');
  expect(resumed?.pausedReason).toBeNull();
});

test('goal command treats bare text as set', async () => {
  const session: Session = {
    id: 'session-command',
    session_key: 'thread-command',
    main_session_key: 'thread-command',
    is_current: 1,
    guild_id: null,
    channel_id: 'tui',
    agent_id: 'agent-a',
    chatbot_id: null,
    model: null,
    enable_rag: 1,
    message_count: 0,
    session_summary: null,
    summary_updated_at: null,
    compaction_count: 0,
    memory_flush_at: null,
    full_auto_enabled: 0,
    full_auto_prompt: null,
    full_auto_started_at: null,
    show_mode: 'all',
    created_at: new Date().toISOString(),
    last_active: new Date().toISOString(),
    reset_count: 0,
    reset_at: null,
    title: null,
    title_source: null,
  };

  const result = await handleGoalCommand({
    session,
    req: {
      sessionId: session.id,
      guildId: null,
      channelId: session.channel_id,
      args: ['goal', 'finish', 'the', 'report'],
      userId: 'user_a',
      username: 'User A',
    },
  });

  expect(result.kind).toBe('plain');
  expect(getThreadGoal('thread-command')?.goalText).toBe('finish the report');
  expect(isGoalInitialPromptScheduled(session.id)).toBe(true);
  clearScheduledGoalContinuation(session.id);
});
