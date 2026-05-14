import os from 'node:os';
import path from 'node:path';
import { beforeEach, expect, test } from 'vitest';
import { handleGoalCommand } from '../src/goals/goal-command.js';
import {
  getThreadGoal,
  MAX_GOAL_TEXT_LENGTH,
  recordThreadGoalTurn,
  resumeThreadGoal,
  setThreadGoal,
  updateThreadGoalStatus,
} from '../src/goals/goal-manager.js';
import {
  clearScheduledGoalContinuation,
  isGoalInitialPromptScheduled,
} from '../src/goals/goal-runtime.js';
import { initDatabase, recordUsageEventBatch } from '../src/memory/db.js';
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

test('caps oversized goal text before persistence', () => {
  const oversizedGoal = 'x'.repeat(MAX_GOAL_TEXT_LENGTH + 100);

  const goal = setThreadGoal({
    threadId: 'thread-long',
    goalText: oversizedGoal,
    maxTurns: 3,
    setterActor: { type: 'user', id: 'user_a' },
    targetAgentId: 'agent-a',
  });

  expect(goal.goalText).toHaveLength(MAX_GOAL_TEXT_LENGTH);
  expect(getThreadGoal('thread-long')?.goalText).toHaveLength(
    MAX_GOAL_TEXT_LENGTH,
  );
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

test('status transitions do not revive terminal goals', () => {
  setThreadGoal({
    threadId: 'thread-terminal',
    goalText: 'triage the queue',
    maxTurns: 3,
    setterActor: { type: 'user', id: 'user_a' },
    targetAgentId: 'agent-a',
  });

  const done = updateThreadGoalStatus({
    threadId: 'thread-terminal',
    status: 'done',
    reason: 'completed',
  });
  expect(done?.status).toBe('done');

  expect(
    updateThreadGoalStatus({
      threadId: 'thread-terminal',
      status: 'paused',
      reason: 'too late',
    }),
  ).toBeNull();
  expect(resumeThreadGoal('thread-terminal')).toBeNull();
  expect(getThreadGoal('thread-terminal')?.status).toBe('done');

  const cleared = updateThreadGoalStatus({
    threadId: 'thread-terminal',
    status: 'cleared',
    reason: 'cleared by user',
  });
  expect(cleared?.status).toBe('cleared');
  expect(resumeThreadGoal('thread-terminal')).toBeNull();
  expect(
    updateThreadGoalStatus({
      threadId: 'thread-terminal',
      status: 'paused',
      reason: 'still too late',
    }),
  ).toBeNull();
  expect(getThreadGoal('thread-terminal')?.status).toBe('cleared');
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
  expect(result.text).toBe('Standing goal set for this thread (max 20).');
  expect(getThreadGoal('thread-command')?.goalText).toBe('finish the report');
  expect(isGoalInitialPromptScheduled(session.id)).toBe(true);
  clearScheduledGoalContinuation(session.id);
});

test('goal command with no args shows status', async () => {
  const session: Session = {
    id: 'session-status',
    session_key: 'thread-status',
    main_session_key: 'thread-status',
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
      args: ['goal'],
      userId: 'user_a',
      username: 'User A',
    },
  });

  expect(result.kind).toBe('info');
  expect(result.title).toBe('Goal Status');
  expect(result.text).toBe('No standing goal is set for this thread.');
});

test('goal command accepts clear aliases', async () => {
  const session: Session = {
    id: 'session-clear-alias',
    session_key: 'thread-clear-alias',
    main_session_key: 'thread-clear-alias',
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
  setThreadGoal({
    threadId: session.main_session_key,
    goalText: 'finish the report',
    maxTurns: 20,
    setterActor: { type: 'user', id: 'user_a' },
    targetAgentId: 'agent-a',
  });

  const result = await handleGoalCommand({
    session,
    req: {
      sessionId: session.id,
      guildId: null,
      channelId: session.channel_id,
      args: ['goal', 'stop'],
      userId: 'user_a',
      username: 'User A',
    },
  });

  expect(result.kind).toBe('plain');
  expect(result.text).toBe('Standing goal cleared.');
  expect(getThreadGoal('thread-clear-alias')?.status).toBe('cleared');
});

test('goal status shows achieved history, elapsed time, and token spend', async () => {
  const session: Session = {
    id: 'session-achieved',
    session_key: 'thread-achieved',
    main_session_key: 'thread-achieved',
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
  setThreadGoal({
    threadId: session.main_session_key,
    goalText: 'all auth tests pass',
    maxTurns: 20,
    setterActor: { type: 'user', id: 'user_a' },
    targetAgentId: 'agent-a',
  });
  recordUsageEventBatch([
    {
      id: 'usage-goal-1',
      sessionId: session.id,
      agentId: 'agent-a',
      model: 'test-model',
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      toolCalls: 0,
      costUsd: 0.0123,
      timestamp: new Date().toISOString(),
      batchId: 'batch-goal',
      batchHash: null,
    },
  ]);
  updateThreadGoalStatus({
    threadId: session.main_session_key,
    status: 'done',
    reason: 'tests passed',
    verdict: 'done',
  });

  const result = await handleGoalCommand({
    session,
    req: {
      sessionId: session.id,
      guildId: null,
      channelId: session.channel_id,
      args: ['goal'],
      userId: 'user_a',
      username: 'User A',
    },
  });

  expect(result.kind).toBe('info');
  expect(result.title).toBe('Goal Status');
  expect(result.text).toContain('Status: achieved');
  expect(result.text).toContain('Condition: all auth tests pass');
  expect(result.text).toMatch(/Elapsed: \d+s/);
  expect(result.text).toContain('Turns evaluated: 0/20');
  expect(result.text).toContain('Tokens: 120 in / 30 out (150 total, ~$0.01)');
  expect(result.text).toContain('Last reason: tests passed');
});
