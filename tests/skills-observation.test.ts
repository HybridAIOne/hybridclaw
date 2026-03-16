import Database from 'better-sqlite3';
import { afterEach, expect, test } from 'vitest';
import type { AdaptiveSkillsTestContext } from './helpers/adaptive-skills-test-setup.ts';
import { createAdaptiveSkillsTestContext } from './helpers/adaptive-skills-test-setup.ts';

let context: AdaptiveSkillsTestContext | null = null;

afterEach(() => {
  context?.cleanup();
  context = null;
});

test('records skill executions and attaches negative feedback', async () => {
  context = await createAdaptiveSkillsTestContext();
  const {
    deriveSkillExecutionOutcome,
    recordSkillExecution,
    recordSkillFeedback,
  } = await import('../src/skills/skills-observation.ts');

  const toolExecutions = [
    {
      name: 'read',
      arguments: '{"path":"README.md"}',
      result: 'ok',
      durationMs: 5,
    },
    {
      name: 'bash',
      arguments: '{"cmd":"false"}',
      result: 'tool failed',
      durationMs: 10,
      isError: true,
    },
  ];
  const observation = await recordSkillExecution({
    skillName: context.skillName,
    sessionId: 'session-1',
    runId: 'run-1',
    toolExecutions,
    outcome: deriveSkillExecutionOutcome({
      outputStatus: 'success',
      toolExecutions,
    }),
    durationMs: 200,
  });

  expect(observation).toMatchObject({
    skill_name: context.skillName,
    session_id: 'session-1',
    run_id: 'run-1',
    outcome: 'partial',
    error_category: 'tool_error',
    tool_calls_attempted: 2,
    tool_calls_failed: 1,
    duration_ms: 200,
  });

  const feedback = recordSkillFeedback({
    sessionId: 'session-1',
    feedback: 'Thumbs down',
    sentiment: 'negative',
  });
  expect(feedback?.feedback_sentiment).toBe('negative');
  expect(feedback?.user_feedback).toBe('Thumbs down');

  await recordSkillExecution({
    skillName: context.skillName,
    sessionId: 'session-2',
    runId: 'run-2',
    toolExecutions: [
      {
        name: 'read',
        arguments: '{"path":"README.md"}',
        result: 'ok',
        durationMs: 5,
      },
    ],
    outcome: 'success',
    durationMs: 75,
  });
  const positiveFeedback = recordSkillFeedback({
    sessionId: 'session-2',
    feedback: 'Thumbs up',
    sentiment: 'positive',
  });
  expect(positiveFeedback?.feedback_sentiment).toBe('positive');

  const observations = context.dbModule.getSkillObservations({
    skillName: context.skillName,
  });
  expect(observations).toHaveLength(2);
  expect(
    observations.map((observation) => observation.feedback_sentiment),
  ).toEqual(['positive', 'negative']);

  const summary = context.dbModule.getSkillObservationSummary({
    skillName: context.skillName,
  })[0];
  expect(summary).toMatchObject({
    total_executions: 2,
    positive_feedback_count: 1,
    negative_feedback_count: 1,
    tool_calls_attempted: 3,
    tool_calls_failed: 1,
  });
  expect(summary?.error_clusters).toEqual([
    expect.objectContaining({ category: 'tool_error', count: 1 }),
  ]);
});

test('classifies timeout and environment-change failures', async () => {
  context = await createAdaptiveSkillsTestContext();
  const { classifyErrorCategory } = await import(
    '../src/skills/skills-observation.ts'
  );

  expect(classifyErrorCategory([], 'request timed out after 30s')).toBe(
    'timeout',
  );
  expect(classifyErrorCategory([], 'ENOENT: no such file or directory')).toBe(
    'env_changed',
  );
});

test('skill observation table enforces outcome and feedback sentiment constraints', async () => {
  context = await createAdaptiveSkillsTestContext();
  const database = new Database(context.dbPath);
  try {
    expect(() =>
      database
        .prepare(
          `INSERT INTO skill_observations (
             skill_name,
             session_id,
             run_id,
             outcome
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(
          context.skillName,
          'session-invalid-outcome',
          'run-invalid',
          'wat',
        ),
    ).toThrow(/CHECK constraint failed/);

    expect(() =>
      database
        .prepare(
          `INSERT INTO skill_observations (
             skill_name,
             session_id,
             run_id,
             outcome,
             feedback_sentiment
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          context.skillName,
          'session-invalid-feedback',
          'run-invalid',
          'success',
          'celebratory',
        ),
    ).toThrow(/CHECK constraint failed/);
  } finally {
    database.close();
  }
});
