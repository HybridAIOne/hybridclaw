import { afterEach, expect, test } from 'vitest';
import type { AdaptiveSkillsTestContext } from './helpers/adaptive-skills-test-setup.ts';
import { createAdaptiveSkillsTestContext } from './helpers/adaptive-skills-test-setup.ts';

let context: AdaptiveSkillsTestContext | null = null;

afterEach(() => {
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

  const metrics = inspectSkill(context.skillName);
  expect(metrics.total_executions).toBe(5);
  expect(metrics.success_rate).toBeCloseTo(0.4);
  expect(metrics.tool_breakage_rate).toBeCloseTo(0.6);
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
