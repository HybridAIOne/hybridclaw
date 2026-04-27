import fs from 'node:fs';
import path from 'node:path';
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

test('records coworker skill scores and refreshes generated CV.md', async () => {
  context = await createAdaptiveSkillsTestContext();
  const { agentWorkspaceDir } = await import('../src/infra/ipc.ts');
  const { recordSkillExecution, recordSkillFeedback } = await import(
    '../src/skills/skills-observation.ts'
  );
  const {
    cv,
    getBestCoworkersForSkill,
    getCoworkerScoreboard,
    recommendCoworkersFor,
  } = await import('../src/skills/coworker-scoreboard.ts');

  recordSkillExecution({
    skillName: context.skillName,
    sessionId: 'session-cv-1',
    runId: 'run-cv-1',
    coworkerId: 'lena',
    toolExecutions: [],
    outcome: 'success',
    durationMs: 100,
  });
  recordSkillFeedback({
    sessionId: 'session-cv-1',
    feedback: 'Great work',
    sentiment: 'positive',
  });
  recordSkillExecution({
    skillName: context.skillName,
    sessionId: 'session-cv-2',
    runId: 'run-cv-2',
    coworkerId: 'lena',
    toolExecutions: [],
    outcome: 'partial',
    durationMs: 200,
  });

  const observations = context.dbModule.getSkillObservations({
    skillName: context.skillName,
    coworkerId: 'lena',
  });
  expect(observations).toHaveLength(2);
  expect(observations[0]?.coworker_id).toBe('lena');

  const [score] = context.dbModule.getCoworkerSkillScores({
    coworkerId: 'lena',
    skillName: context.skillName,
  });
  expect(score).toMatchObject({
    coworker_id: 'lena',
    skill_id: context.skillName,
    skill_name: context.skillName,
    total_executions: 2,
    success_count: 1,
    partial_count: 1,
    positive_feedback_count: 1,
  });
  expect(score?.quality_score).toBeGreaterThan(50);
  expect(score?.last_run_at).toBeTruthy();

  const database = new Database(context.dbPath);
  const scoreRows = database
    .prepare(
      `SELECT coworker_id, skill_id, success_count, partial_count, quality_score
       FROM coworker_skill_scores
       WHERE coworker_id = ? AND skill_id = ?`,
    )
    .all('lena', context.skillName);
  database.close();
  expect(scoreRows).toEqual([
    expect.objectContaining({
      coworker_id: 'lena',
      skill_id: context.skillName,
      success_count: 1,
      partial_count: 1,
      quality_score: expect.any(Number),
    }),
  ]);

  expect(getBestCoworkersForSkill(context.skillName)[0]?.coworker_id).toBe(
    'lena',
  );
  expect(getCoworkerScoreboard()[0]).toMatchObject({
    coworker_id: 'lena',
    total_executions: 2,
  });

  const cvPath = path.join(agentWorkspaceDir('lena'), 'CV.md');
  expect(fs.readFileSync(cvPath, 'utf-8')).toContain(
    `Best at: ${context.skillName}`,
  );

  context.dbModule.upsertAgent({
    id: 'nova',
    name: 'Nova',
    role: 'Research Analyst',
    imageAsset: 'assets/nova.png',
  });
  expect(
    cv('nova', { generatedAt: '2026-04-27T10:00:00.000Z' }),
  ).toMatchInlineSnapshot(`
      "<!-- Generated by HybridClaw coworker scoreboard. -->
      # Nova CV

      ![Nova](assets/nova.png)

      Coworker ID: \`nova\`
      Role: Research Analyst
      Last updated: 2026-04-27T10:00:00.000Z

      ## Track Record

      - Skill executions: 0
      - Overall success rate: 0%
      - Average score: 0/100

      ## Skill Scores

      No observed skill runs yet.

      ## Recent Track Record

      No recent skill runs yet.
      "
    `);

  recordSkillExecution({
    skillName: context.skillName,
    sessionId: 'session-cv-3',
    runId: 'run-cv-3',
    coworkerId: 'mika',
    toolExecutions: [],
    outcome: 'failure',
    durationMs: 300,
  });
  expect(recommendCoworkersFor('demo skill task')).toEqual([
    expect.objectContaining({
      coworker_id: 'lena',
      skill_id: context.skillName,
    }),
    expect.objectContaining({
      coworker_id: 'mika',
      skill_id: context.skillName,
    }),
  ]);

  for (const runId of ['run-charly-1', 'run-charly-2']) {
    recordSkillExecution({
      skillName: context.skillName,
      sessionId: `session-${runId}`,
      runId,
      coworkerId: 'charly',
      toolExecutions: [
        {
          name: 'read',
          arguments: '{}',
          result: 'ok',
          durationMs: 5,
        },
        {
          name: 'write',
          arguments: '{}',
          result: 'ok',
          durationMs: 5,
        },
        {
          name: 'notify',
          arguments: '{}',
          result: 'this action may change channel state',
          durationMs: 5,
          isError: true,
        },
      ],
      outcome: 'partial',
      durationMs: 30_000,
    });
  }

  const [partialScore] = context.dbModule.getCoworkerSkillScores({
    coworkerId: 'charly',
    skillName: context.skillName,
  });
  expect(partialScore).toMatchObject({
    coworker_id: 'charly',
    success_count: 0,
    partial_count: 2,
    failure_count: 0,
  });
  expect(partialScore?.quality_score).toBeGreaterThan(50);
});

test('emits a skill_run event to subscribers for every skill execution', async () => {
  context = await createAdaptiveSkillsTestContext();
  const { subscribeSkillRunEvents } = await import(
    '../src/skills/skill-run-events.ts'
  );
  const { recordSkillExecution } = await import(
    '../src/skills/skills-observation.ts'
  );

  const events: unknown[] = [];
  const unsubscribe = subscribeSkillRunEvents((event) => {
    events.push(event);
  });
  try {
    recordSkillExecution({
      skillName: context.skillName,
      sessionId: 'session-event-1',
      runId: 'run-event-1',
      toolExecutions: [
        {
          name: 'bash',
          arguments: JSON.stringify({
            cmd: 'echo hello',
            apiKey: 'test-key',
            nested: { token: 'secret-token' },
          }),
          result: `${'x'.repeat(320)} secret-token`,
          durationMs: 11,
        },
      ],
      outcome: 'success',
      durationMs: 30,
      model: 'test-model',
      coworkerId: 'coworker-1',
      input: {
        prompt: 'draft the note',
        apiKey: 'test-key',
        body: 'i'.repeat(4_500),
      },
      output: { text: 'done', token: 'secret-token' },
      tokenUsage: {
        modelCalls: 1,
        apiUsageAvailable: false,
        apiPromptTokens: 0,
        apiCompletionTokens: 0,
        apiTotalTokens: 0,
        apiCacheUsageAvailable: false,
        apiCacheReadTokens: 0,
        apiCacheWriteTokens: 0,
        estimatedPromptTokens: 9,
        estimatedCompletionTokens: 3,
        estimatedTotalTokens: 12,
      },
      costUsd: 0.001,
    });

    recordSkillExecution({
      skillName: context.skillName,
      sessionId: 'session-event-2',
      runId: 'run-event-2',
      toolExecutions: [],
      outcome: 'success',
      durationMs: 40,
      tokenUsage: {
        modelCalls: 0,
        apiUsageAvailable: false,
        apiPromptTokens: 0,
        apiCompletionTokens: 0,
        apiTotalTokens: 0,
        apiCacheUsageAvailable: false,
        apiCacheReadTokens: 0,
        apiCacheWriteTokens: 0,
        estimatedPromptTokens: 0,
        estimatedCompletionTokens: 0,
        estimatedTotalTokens: 0,
      },
      costUsd: -1,
    });
  } finally {
    unsubscribe();
  }

  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({
    type: 'skill_run',
    skill_id: context.skillName,
    coworker_id: 'coworker-1',
    session_id: 'session-event-1',
    run_id: 'run-event-1',
    input: {
      content: expect.stringContaining('draft the note'),
      truncated: true,
    },
    output: {
      content: '{"text":"done","token":"***"}',
      truncated: false,
    },
    model: 'test-model',
    tokens: {
      prompt: 9,
      completion: 3,
      total: 12,
      modelCalls: 1,
      apiUsageAvailable: false,
      estimatedPrompt: 9,
      estimatedCompletion: 3,
      estimatedTotal: 12,
      apiPrompt: 0,
      apiCompletion: 0,
      apiTotal: 0,
    },
    latency_ms: 30,
    cost_usd: 0.001,
    errors: [],
    tool_executions: [
      {
        name: 'bash',
        duration_ms: 11,
        is_error: false,
        blocked: false,
      },
    ],
  });
  expect(JSON.stringify(events[0])).not.toContain('echo hello');
  expect(JSON.stringify(events[0])).not.toContain('secret-token');
  expect(JSON.stringify(events[0])).not.toContain('test-key');
  expect(
    (events[0] as { input: { content: string } }).input.content.length,
  ).toBeLessThanOrEqual(4099);
  expect(events[1]).toMatchObject({
    type: 'skill_run',
    session_id: 'session-event-2',
    input: null,
    output: null,
    tokens: expect.objectContaining({ modelCalls: 0 }),
    cost_usd: 0,
  });
});

test('skill_run subscriber failures do not block observation persistence', async () => {
  context = await createAdaptiveSkillsTestContext();
  const { subscribeSkillRunEvents } = await import(
    '../src/skills/skill-run-events.ts'
  );
  const { recordSkillExecution } = await import(
    '../src/skills/skills-observation.ts'
  );

  const unsubscribe = subscribeSkillRunEvents(() => {
    throw new Error('subscriber failed');
  });
  try {
    const observation = recordSkillExecution({
      skillName: context.skillName,
      sessionId: 'session-subscriber-failure',
      runId: 'run-subscriber-failure',
      toolExecutions: [],
      outcome: 'success',
      durationMs: 20,
    });

    expect(observation).toMatchObject({
      skill_name: context.skillName,
      session_id: 'session-subscriber-failure',
      run_id: 'run-subscriber-failure',
      outcome: 'success',
    });
  } finally {
    unsubscribe();
  }
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
