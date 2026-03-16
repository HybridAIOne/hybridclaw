import fs from 'node:fs';
import { afterEach, expect, test } from 'vitest';
import type { SkillCogneeTestContext } from './helpers/skill-cognee-test-setup.ts';
import { createSkillCogneeTestContext } from './helpers/skill-cognee-test-setup.ts';

let context: SkillCogneeTestContext | null = null;

afterEach(() => {
  context?.cleanup();
  context = null;
});

test('evaluates applied amendments and keeps improvements', async () => {
  context = await createSkillCogneeTestContext();
  const { getRuntimeConfig } = await import('../src/config/runtime-config.ts');
  const { createSkillAmendment, getLatestSkillAmendment } = await import(
    '../src/memory/db.ts'
  );
  const { evaluateAmendment } = await import(
    '../src/skills/skills-evaluation.ts'
  );

  context.dbModule.recordSkillObservation({
    skillName: context.skillName,
    sessionId: 'session-1',
    runId: 'run-1',
    outcome: 'success',
    toolCallsAttempted: 1,
    toolCallsFailed: 0,
    durationMs: 50,
  });
  context.dbModule.recordSkillObservation({
    skillName: context.skillName,
    sessionId: 'session-2',
    runId: 'run-2',
    outcome: 'success',
    toolCallsAttempted: 1,
    toolCallsFailed: 0,
    durationMs: 55,
  });

  createSkillAmendment({
    skillName: context.skillName,
    skillFilePath: context.skillFilePath,
    status: 'applied',
    originalContent: fs.readFileSync(context.skillFilePath, 'utf-8'),
    proposedContent: fs.readFileSync(context.skillFilePath, 'utf-8'),
    originalContentHash: 'a',
    proposedContentHash: 'b',
    rationale: 'Improve clarity',
    diffSummary: 'Changed 1 line',
    proposedBy: 'test',
    reviewedBy: 'reviewer',
    guardVerdict: 'safe',
    guardFindingsCount: 0,
    metricsAtProposal: {
      skill_name: context.skillName,
      total_executions: 2,
      success_rate: 0.2,
      avg_duration_ms: 100,
      error_clusters: [],
      tool_breakage_rate: 0,
      negative_feedback_count: 0,
      degraded: true,
      degradation_reasons: ['success rate'],
      window_started_at: new Date().toISOString(),
      window_ended_at: new Date().toISOString(),
    },
    runsSinceApply: 3,
  });

  const result = evaluateAmendment({
    skillName: context.skillName,
    config: getRuntimeConfig().skillCognee,
  });
  expect(result.action).toBe('keep');

  const latest = getLatestSkillAmendment({
    skillName: context.skillName,
    status: 'applied',
  });
  expect(latest?.metrics_post_apply?.success_rate).toBeCloseTo(1);
});

test('rolls back applied amendments when improvement stays below threshold', async () => {
  context = await createSkillCogneeTestContext();
  const { getRuntimeConfig } = await import('../src/config/runtime-config.ts');
  const { createSkillAmendment, getSkillAmendmentById } = await import(
    '../src/memory/db.ts'
  );
  const { evaluateAmendment, rollbackAmendment } = await import(
    '../src/skills/skills-evaluation.ts'
  );

  fs.writeFileSync(context.skillFilePath, 'amended content\n', 'utf-8');
  context.dbModule.recordSkillObservation({
    skillName: context.skillName,
    sessionId: 'session-1',
    runId: 'run-1',
    outcome: 'failure',
    errorCategory: 'model_error',
    errorDetail: 'still failing',
    toolCallsAttempted: 1,
    toolCallsFailed: 0,
    durationMs: 60,
  });

  const amendment = createSkillAmendment({
    skillName: context.skillName,
    skillFilePath: context.skillFilePath,
    status: 'applied',
    originalContent: 'original content\n',
    proposedContent: 'amended content\n',
    originalContentHash: 'a',
    proposedContentHash: 'b',
    rationale: 'Try to improve',
    diffSummary: 'Changed 1 line',
    proposedBy: 'test',
    reviewedBy: 'reviewer',
    guardVerdict: 'safe',
    guardFindingsCount: 0,
    metricsAtProposal: {
      skill_name: context.skillName,
      total_executions: 1,
      success_rate: 0.8,
      avg_duration_ms: 100,
      error_clusters: [],
      tool_breakage_rate: 0,
      negative_feedback_count: 0,
      degraded: false,
      degradation_reasons: [],
      window_started_at: new Date().toISOString(),
      window_ended_at: new Date().toISOString(),
    },
    runsSinceApply: 3,
  });

  const evaluation = evaluateAmendment({
    skillName: context.skillName,
    config: getRuntimeConfig().skillCognee,
  });
  expect(evaluation.action).toBe('rollback');

  const rollback = await rollbackAmendment({
    amendmentId: amendment.id,
    reason: 'No measurable improvement',
  });
  expect(rollback.ok).toBe(true);
  expect(fs.readFileSync(context.skillFilePath, 'utf-8')).toBe(
    'original content\n',
  );
  expect(getSkillAmendmentById(amendment.id)?.status).toBe('rolled_back');
});
