import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, test, vi } from 'vitest';
import type { AdaptiveSkillsTestContext } from './helpers/adaptive-skills-test-setup.ts';
import { createAdaptiveSkillsTestContext } from './helpers/adaptive-skills-test-setup.ts';

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

let context: AdaptiveSkillsTestContext | null = null;

afterEach(() => {
  runAgentMock.mockReset();
  context?.cleanup();
  context = null;
});

test('computes health metrics and degradation reasons from observations', async () => {
  context = await createAdaptiveSkillsTestContext();
  const { inspectSkill } = await import('../src/skills/skills-inspection.ts');

  for (let index = 0; index < 5; index += 1) {
    context.dbModule.recordSkillObservation({
      skillName: context.skillName,
      sessionId: `session-${index}`,
      runId: `run-${index}`,
      outcome: index < 2 ? 'success' : 'failure',
      errorCategory: index < 2 ? null : 'tool_error',
      errorDetail: index < 2 ? null : `tool failure ${index}`,
      toolCallsAttempted: 1,
      toolCallsFailed: index < 2 ? 0 : 1,
      durationMs: 100 + index,
    });
  }
  context.dbModule.attachFeedbackToObservation({
    sessionId: 'session-4',
    feedback: 'Bad result',
    sentiment: 'negative',
  });
  context.dbModule.attachFeedbackToObservation({
    sessionId: 'session-3',
    feedback: 'Still bad',
    sentiment: 'negative',
  });
  context.dbModule.attachFeedbackToObservation({
    sessionId: 'session-1',
    feedback: 'Nice recovery',
    sentiment: 'positive',
  });

  const metrics = inspectSkill(context.skillName);
  expect(metrics.total_executions).toBe(5);
  expect(metrics.success_rate).toBeCloseTo(0.4);
  expect(metrics.tool_breakage_rate).toBeCloseTo(0.6);
  expect(metrics.positive_feedback_count).toBe(1);
  expect(metrics.negative_feedback_count).toBe(2);
  expect(metrics.degraded).toBe(true);
  expect(metrics.degradation_reasons).toEqual([
    expect.stringContaining('success rate'),
    expect.stringContaining('tool breakage'),
    expect.stringContaining('negative feedback spike'),
  ]);
  expect(metrics.error_clusters).toEqual([
    expect.objectContaining({ category: 'tool_error', count: 3 }),
  ]);
});

test('inspectAllSkills sorts degraded skills ahead of healthy ones', async () => {
  context = await createAdaptiveSkillsTestContext();
  const { inspectAllSkills } = await import(
    '../src/skills/skills-inspection.ts'
  );

  context.dbModule.recordSkillObservation({
    skillName: context.skillName,
    sessionId: 'session-a',
    runId: 'run-a',
    outcome: 'failure',
    errorCategory: 'model_error',
    errorDetail: 'bad answer',
    toolCallsAttempted: 1,
    toolCallsFailed: 0,
    durationMs: 100,
  });
  context.dbModule.recordSkillObservation({
    skillName: 'healthy-skill',
    sessionId: 'session-b',
    runId: 'run-b',
    outcome: 'success',
    toolCallsAttempted: 1,
    toolCallsFailed: 0,
    durationMs: 90,
  });

  const metricsList = inspectAllSkills();
  expect(metricsList.map((entry) => entry.skill_name)).toEqual([
    context.skillName,
    'healthy-skill',
  ]);
  expect(metricsList[0]?.degraded).toBe(true);
  expect(metricsList[1]?.degraded).toBe(false);
});

test('runPeriodicSkillInspection queues amendment proposals without blocking the inspection call', async () => {
  context = await createAdaptiveSkillsTestContext();
  context.runtimeConfigModule.updateRuntimeConfig((draft) => {
    draft.adaptiveSkills.enabled = true;
    draft.adaptiveSkills.minExecutionsForInspection = 1;
    draft.adaptiveSkills.inspectionIntervalMs = 0;
  });
  context.dbModule.recordSkillObservation({
    skillName: context.skillName,
    sessionId: 'session-queue',
    runId: 'run-queue',
    outcome: 'failure',
    errorCategory: 'model_error',
    errorDetail: 'too vague',
    toolCallsAttempted: 1,
    toolCallsFailed: 0,
    durationMs: 100,
  });

  let resolveProposal: ((value: unknown) => void) | null = null;
  runAgentMock.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveProposal = resolve;
    }),
  );

  const { getLatestSkillAmendment } = await import('../src/memory/db.ts');
  const { runPeriodicSkillInspection, waitForQueuedSkillAmendments } =
    await import('../src/skills/skills-inspection.ts');

  const metricsList = await runPeriodicSkillInspection({ agentId: 'main' });
  expect(metricsList).toHaveLength(1);
  expect(metricsList[0]?.degraded).toBe(true);
  expect(getLatestSkillAmendment({ skillName: context.skillName })).toBeNull();

  resolveProposal?.({
    status: 'success',
    result: JSON.stringify({
      rationale: 'Add a checklist.',
      content: `---
name: ${context.skillName}
description: Demo skill for tests
---
Follow the user's request carefully.
List the required steps before acting.
Keep the response concise.
`,
    }),
    toolsUsed: [],
  });

  await waitForQueuedSkillAmendments();
  expect(
    getLatestSkillAmendment({ skillName: context.skillName })?.status,
  ).toBe('staged');
});

test('runPeriodicSkillInspection prunes observations older than the retention window', async () => {
  context = await createAdaptiveSkillsTestContext();
  context.runtimeConfigModule.updateRuntimeConfig((draft) => {
    draft.adaptiveSkills.enabled = false;
    draft.adaptiveSkills.observationEnabled = true;
    draft.adaptiveSkills.inspectionIntervalMs = 0;
    draft.adaptiveSkills.observationRetentionDays = 7;
  });

  context.dbModule.recordSkillObservation({
    skillName: context.skillName,
    sessionId: 'session-old',
    runId: 'run-old',
    outcome: 'failure',
    errorCategory: 'model_error',
    errorDetail: 'stale row',
    toolCallsAttempted: 1,
    toolCallsFailed: 0,
    durationMs: 100,
  });
  context.dbModule.recordSkillObservation({
    skillName: context.skillName,
    sessionId: 'session-new',
    runId: 'run-new',
    outcome: 'success',
    toolCallsAttempted: 1,
    toolCallsFailed: 0,
    durationMs: 80,
  });

  const database = new Database(context.dbPath);
  try {
    database
      .prepare(
        `UPDATE skill_observations
         SET created_at = ?
         WHERE session_id = ?`,
      )
      .run(
        new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString(),
        'session-old',
      );
  } finally {
    database.close();
  }

  const { runPeriodicSkillInspection } = await import(
    '../src/skills/skills-inspection.ts'
  );
  const result = await runPeriodicSkillInspection({ agentId: 'cleanup' });
  expect(result).toEqual([]);

  const observations = context.dbModule.getSkillObservations({
    skillName: context.skillName,
  });
  expect(observations.map((entry) => entry.session_id)).toEqual([
    'session-new',
  ]);
});

test('runPeriodicSkillInspection prunes expired trajectory files by tenant policy', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2024-01-15T12:00:00.000Z'));

  try {
    context = await createAdaptiveSkillsTestContext();
    const storeDir = path.join(context.homeDir, 'trajectory-store');
    context.runtimeConfigModule.updateRuntimeConfig((draft) => {
      draft.adaptiveSkills.enabled = false;
      draft.adaptiveSkills.inspectionIntervalMs = 0;
      draft.adaptiveSkills.trajectoryCapture.storeDir = storeDir;
      draft.adaptiveSkills.trajectoryCapture.retentionDays = 365;
      draft.adaptiveSkills.trajectoryCapture.retentionDaysByTenant = {
        'agent-short': 1,
        'agent-keep': 999,
      };
    });

    const dateDaysAgo = (days: number) =>
      new Date(Date.now() - days * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
    const writeTrajectory = (date: string, agentId: string) => {
      const filePath = path.join(storeDir, date, `${agentId}.jsonl`);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(
        filePath,
        `${JSON.stringify({
          schema_version: 2,
          tenant_id: agentId,
          agent_id: agentId,
        })}\n`,
        'utf-8',
      );
      return filePath;
    };

    const staleDefaultPath = writeTrajectory(dateDaysAgo(400), 'agent-default');
    const staleShortPath = writeTrajectory(dateDaysAgo(5), 'agent-short');
    const retainedOverridePath = writeTrajectory(
      dateDaysAgo(400),
      'agent-keep',
    );
    const retainedDefaultPath = writeTrajectory(
      dateDaysAgo(2),
      'agent-default',
    );

    const { runPeriodicSkillInspection } = await import(
      '../src/skills/skills-inspection.ts'
    );
    const result = await runPeriodicSkillInspection({
      agentId: 'trajectory-cleanup',
    });
    expect(result).toEqual([]);

    expect(fs.existsSync(staleDefaultPath)).toBe(false);
    expect(fs.existsSync(staleShortPath)).toBe(false);
    expect(fs.existsSync(retainedOverridePath)).toBe(true);
    expect(fs.existsSync(retainedDefaultPath)).toBe(true);
    expect(fs.existsSync(path.dirname(staleShortPath))).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test('pruneExpiredSkillRunTrajectories resolves empty store dir from provided runtime config', async () => {
  context = await createAdaptiveSkillsTestContext();
  const runtimeConfig = context.runtimeConfigModule.getRuntimeConfig();
  const configuredDbPath = path.join(
    context.homeDir,
    'configured-data',
    'test.db',
  );
  const configuredStoreDir = path.join(
    path.dirname(configuredDbPath),
    'trajectories',
  );
  const runtimeStoreDir = path.join(
    path.dirname(context.dbPath),
    'trajectories',
  );

  const writeTrajectory = (storeDir: string) => {
    const filePath = path.join(storeDir, '2024-01-01', 'agent-default.jsonl');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      `${JSON.stringify({
        schema_version: 2,
        tenant_id: 'agent-default',
        agent_id: 'agent-default',
      })}\n`,
      'utf-8',
    );
    return filePath;
  };

  const configuredPath = writeTrajectory(configuredStoreDir);
  const runtimePath = writeTrajectory(runtimeStoreDir);
  const { pruneExpiredSkillRunTrajectories } = await import(
    '../src/skills/skill-run-trajectories.ts'
  );

  const pruned = pruneExpiredSkillRunTrajectories({
    config: {
      ...runtimeConfig,
      ops: {
        ...runtimeConfig.ops,
        dbPath: configuredDbPath,
      },
      adaptiveSkills: {
        ...runtimeConfig.adaptiveSkills,
        trajectoryCapture: {
          ...runtimeConfig.adaptiveSkills.trajectoryCapture,
          storeDir: '',
          retentionDays: 1,
          retentionDaysByTenant: {},
        },
      },
    },
    now: new Date('2024-01-15T12:00:00.000Z'),
  });

  expect(pruned).toBe(1);
  expect(fs.existsSync(configuredPath)).toBe(false);
  expect(fs.existsSync(runtimePath)).toBe(true);
});
