import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { emitPostTurnEvent } from '../src/agent/post-turn-events.js';
import { judgeGoalCompletion } from '../src/goals/goal-judge.js';
import { getThreadGoal, setThreadGoal } from '../src/goals/goal-manager.js';
import {
  buildGoalContinuationPrompt,
  buildGoalInitialPrompt,
  clearScheduledGoalContinuation,
  finishGoalContinuationRun,
  GOAL_CONTINUATION_SOURCE,
  isGoalInitialPromptScheduled,
  pauseGoalForAgentBudgetHardStop,
  registerGoalPostTurnSubscriber,
  scheduleGoalContinuation,
  setGoalContinuationRunHandler,
  setGoalContinuationRunning,
} from '../src/goals/goal-runtime.js';
import { initDatabase } from '../src/memory/db.js';
import type { ToolExecution } from '../src/types/execution.js';
import type { Session } from '../src/types/session.js';

vi.mock('../src/goals/goal-judge.js', () => ({
  judgeGoalCompletion: vi.fn(async () => ({
    done: false,
    reason: 'more work remains',
    parseFailure: false,
  })),
}));

function tempDbPath(): string {
  return path.join(
    os.tmpdir(),
    `hybridclaw-goal-runtime-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
  );
}

function makeSession(id: string): Session {
  return {
    id,
    session_key: `thread-${id}`,
    main_session_key: `thread-${id}`,
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
}

beforeEach(() => {
  initDatabase({ quiet: true, dbPath: tempDbPath() });
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

test('continuation prompt is a user-turn snapshot and does not replace system prompt', () => {
  expect(buildGoalInitialPrompt('finish the report')).toBe(
    [
      '[Starting standing goal]',
      'Goal: finish the report',
      '',
      'This is supervised step 1.',
      'Use this as a fresh goal start; do not infer goal progress from earlier chat.',
      'If the goal is an ordered sequence, produce only the first item for this step.',
      '',
      'Start working toward this goal. Take the first concrete step. If you',
      'believe the goal is complete, state so explicitly and stop. If you are',
      'blocked, say so clearly and stop.',
    ].join('\n'),
  );
  expect(buildGoalContinuationPrompt('finish the report')).toBe(
    [
      '[Continuing toward your standing goal]',
      'Goal: finish the report',
      '',
      'Continue working toward this goal. Take the next concrete step. If you',
      'believe the goal is complete, state so explicitly and stop. If you are',
      'blocked, say so clearly and stop.',
    ].join('\n'),
  );
});

test('continuation prompt can carry supervised step progress', () => {
  expect(
    buildGoalContinuationPrompt('count from 1 to 4', {
      turnsUsed: 2,
      maxTurns: 20,
    }),
  ).toBe(
    [
      '[Continuing toward your standing goal]',
      'Goal: count from 1 to 4',
      '',
      'Progress: 2 supervised turn(s) have already been used for this goal.',
      'This is supervised step 3 of at most 20.',
      'Use this progress snapshot as authoritative; do not infer goal progress from earlier chat.',
      'Do not repeat completed steps. If the goal is an ordered sequence, produce the next item for this step.',
      '',
      'Continue working toward this goal. Take the next concrete step. If you',
      'believe the goal is complete, state so explicitly and stop. If you are',
      'blocked, say so clearly and stop.',
    ].join('\n'),
  );
});

test('set can schedule the raw goal text as the first supervised turn', () => {
  const session = makeSession('initial');
  setThreadGoal({
    threadId: session.main_session_key,
    goalText: 'finish the report',
    maxTurns: 5,
    setterActor: { type: 'user', id: 'user_a' },
    targetAgentId: 'agent-a',
  });

  scheduleGoalContinuation({
    session,
    initialPrompt: true,
    context: {
      guildId: null,
      userId: 'user_a',
      username: 'User A',
    },
  });

  expect(isGoalInitialPromptScheduled(session.id)).toBe(true);
  clearScheduledGoalContinuation(session.id);
});

test('post-turn goal subscriber pauses on pending approval without spending a turn', async () => {
  registerGoalPostTurnSubscriber();
  const session = makeSession('approval');
  setThreadGoal({
    threadId: session.main_session_key,
    goalText: 'finish the report',
    maxTurns: 5,
    setterActor: { type: 'user', id: 'user_a' },
    targetAgentId: 'agent-a',
  });
  const requiredTool: ToolExecution = {
    name: 'exec_command',
    arguments: '{}',
    result: '',
    durationMs: 1,
    approvalDecision: 'required',
  };

  await emitPostTurnEvent({
    type: 'post_turn',
    session,
    req: {
      source: GOAL_CONTINUATION_SOURCE,
      guildId: null,
      userId: 'user_a',
      username: 'User A',
    },
    result: {
      status: 'success',
      result: 'Waiting for approval.',
      toolsUsed: [],
      toolExecutions: [requiredTool],
    },
    runId: 'turn-a',
    createdAt: new Date().toISOString(),
  });

  const goal = getThreadGoal(session.main_session_key);
  expect(goal?.status).toBe('paused');
  expect(goal?.turnsUsed).toBe(0);
  expect(goal?.pausedReason).toBe('pending approval');
  expect(judgeGoalCompletion).not.toHaveBeenCalled();
});

test('post-turn goal subscriber pauses failed continuation turns', async () => {
  registerGoalPostTurnSubscriber();
  const session = makeSession('agent-error');
  setThreadGoal({
    threadId: session.main_session_key,
    goalText: 'finish the report',
    maxTurns: 5,
    setterActor: { type: 'user', id: 'user_a' },
    targetAgentId: 'agent-a',
  });

  await emitPostTurnEvent({
    type: 'post_turn',
    session,
    req: {
      source: GOAL_CONTINUATION_SOURCE,
      guildId: null,
      userId: 'user_a',
      username: 'User A',
    },
    result: {
      status: 'error',
      result: null,
      toolsUsed: [],
      error: 'agent failed',
    },
    runId: 'turn-error',
    createdAt: new Date().toISOString(),
  });

  const goal = getThreadGoal(session.main_session_key);
  expect(goal?.status).toBe('paused');
  expect(goal?.turnsUsed).toBe(0);
  expect(goal?.pausedReason).toBe('agent failed');
  expect(judgeGoalCompletion).not.toHaveBeenCalled();
});

test('post-turn goal subscriber hard-stops at max turns', async () => {
  registerGoalPostTurnSubscriber();
  const session = makeSession('budget');
  setThreadGoal({
    threadId: session.main_session_key,
    goalText: 'ship the patch',
    maxTurns: 1,
    setterActor: { type: 'user', id: 'user_a' },
    targetAgentId: 'agent-a',
  });

  await emitPostTurnEvent({
    type: 'post_turn',
    session,
    req: {
      source: GOAL_CONTINUATION_SOURCE,
      guildId: null,
      userId: 'user_a',
      username: 'User A',
    },
    result: {
      status: 'success',
      result: 'I completed the first step.',
      toolsUsed: [],
    },
    runId: 'turn-b',
    createdAt: new Date().toISOString(),
  });
  clearScheduledGoalContinuation(session.id);

  const goal = getThreadGoal(session.main_session_key);
  expect(goal?.status).toBe('paused');
  expect(goal?.turnsUsed).toBe(1);
  expect(goal?.pausedReason).toBe('turn budget reached');
  expect(judgeGoalCompletion).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: session.id,
      agentId: 'agent-a',
      threadId: session.main_session_key,
      goalText: 'ship the patch',
      assistantResponse: 'I completed the first step.',
    }),
  );
});

test('post-turn goal subscriber completes without scheduling another continuation', async () => {
  registerGoalPostTurnSubscriber();
  const session = makeSession('complete');
  const runHandler = vi.fn(async () => undefined);
  setGoalContinuationRunHandler(runHandler);
  vi.mocked(judgeGoalCompletion).mockResolvedValueOnce({
    done: true,
    reason: 'assistant explicitly completed the goal',
    parseFailure: false,
  });
  setThreadGoal({
    threadId: session.main_session_key,
    goalText:
      'Count from 1 to 4, one number per turn. When you reach 4, state that the goal is complete.',
    maxTurns: 20,
    setterActor: { type: 'user', id: 'user_a' },
    targetAgentId: 'agent-a',
  });

  await emitPostTurnEvent({
    type: 'post_turn',
    session,
    req: {
      source: GOAL_CONTINUATION_SOURCE,
      guildId: null,
      userId: 'user_a',
      username: 'User A',
    },
    result: {
      status: 'success',
      result: '4\n\nGoal complete.',
      toolsUsed: [],
    },
    runId: 'turn-complete',
    createdAt: new Date().toISOString(),
  });

  const goal = getThreadGoal(session.main_session_key);
  expect(goal?.status).toBe('done');
  expect(goal?.turnsUsed).toBe(1);
  expect(goal?.lastVerdict).toBe('done');
  expect(runHandler).not.toHaveBeenCalled();
});

test('post-turn goal subscriber caps assistant response sent to the judge', async () => {
  registerGoalPostTurnSubscriber();
  const session = makeSession('judge-cap');
  setThreadGoal({
    threadId: session.main_session_key,
    goalText: 'ship the patch',
    maxTurns: 5,
    setterActor: { type: 'user', id: 'user_a' },
    targetAgentId: 'agent-a',
  });

  await emitPostTurnEvent({
    type: 'post_turn',
    session,
    req: {
      source: GOAL_CONTINUATION_SOURCE,
      guildId: null,
      userId: 'user_a',
      username: 'User A',
    },
    result: {
      status: 'success',
      result: 'x'.repeat(8_100),
      toolsUsed: [],
    },
    runId: 'turn-cap',
    createdAt: new Date().toISOString(),
  });

  expect(judgeGoalCompletion).toHaveBeenCalledWith(
    expect.objectContaining({
      assistantResponse: 'x'.repeat(8_000),
    }),
  );
  clearScheduledGoalContinuation(session.id);
});

test('scheduled continuation queues a direct rerun while runner is active', () => {
  const session = makeSession('rearm');
  setThreadGoal({
    threadId: session.main_session_key,
    goalText: 'ship the patch',
    maxTurns: 5,
    setterActor: { type: 'user', id: 'user_a' },
    targetAgentId: 'agent-a',
  });
  const runHandler = vi.fn(async () => undefined);
  setGoalContinuationRunHandler(runHandler);

  scheduleGoalContinuation({
    session,
    context: {
      guildId: null,
      userId: 'user_a',
      username: 'User A',
    },
  });
  expect(runHandler).toHaveBeenCalledWith(session.id);

  runHandler.mockClear();
  setGoalContinuationRunning(session.id, true);
  scheduleGoalContinuation({
    session,
    context: {
      guildId: null,
      userId: 'user_a',
      username: 'User A',
    },
  });
  expect(runHandler).not.toHaveBeenCalled();

  finishGoalContinuationRun(session.id);

  expect(runHandler).toHaveBeenCalledWith(session.id);
  clearScheduledGoalContinuation(session.id);
});

test('post-turn goal subscriber pauses if a goal continuation was interrupted', async () => {
  registerGoalPostTurnSubscriber();
  const session = makeSession('interrupted');
  const controller = new AbortController();
  controller.abort();
  setThreadGoal({
    threadId: session.main_session_key,
    goalText: 'ship the patch',
    maxTurns: 5,
    setterActor: { type: 'user', id: 'user_a' },
    targetAgentId: 'agent-a',
  });

  await emitPostTurnEvent({
    type: 'post_turn',
    session,
    req: {
      source: GOAL_CONTINUATION_SOURCE,
      guildId: null,
      userId: 'user_a',
      username: 'User A',
      abortSignal: controller.signal,
    },
    result: {
      status: 'success',
      result: 'This was interrupted while finishing.',
      toolsUsed: [],
    },
    runId: 'turn-interrupted',
    createdAt: new Date().toISOString(),
  });

  const goal = getThreadGoal(session.main_session_key);
  expect(goal?.status).toBe('paused');
  expect(goal?.turnsUsed).toBe(0);
  expect(goal?.pausedReason).toBe('user-interrupted');
  expect(judgeGoalCompletion).not.toHaveBeenCalled();
});

test('budget hard-stop hook pauses active goals for R5.3 integration', () => {
  const session = makeSession('budget-hook');
  setThreadGoal({
    threadId: session.main_session_key,
    goalText: 'ship the patch',
    maxTurns: 5,
    setterActor: { type: 'user', id: 'user_a' },
    targetAgentId: 'agent-a',
  });

  pauseGoalForAgentBudgetHardStop(session);

  const goal = getThreadGoal(session.main_session_key);
  expect(goal?.status).toBe('paused');
  expect(goal?.pausedReason).toBe('agent budget hard-stop');
});
