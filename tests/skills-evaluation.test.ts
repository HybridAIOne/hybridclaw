import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { afterEach, expect, test } from 'vitest';
import type { AdaptiveSkillsTestContext } from './helpers/adaptive-skills-test-setup.ts';
import { createAdaptiveSkillsTestContext } from './helpers/adaptive-skills-test-setup.ts';

let context: AdaptiveSkillsTestContext | null = null;

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

afterEach(() => {
  context?.cleanup();
  context = null;
});

test('evaluates applied amendments and keeps improvements', async () => {
  context = await createAdaptiveSkillsTestContext();
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
      success_count: 0,
      partial_count: 0,
      failure_count: 2,
      success_rate: 0.2,
      avg_duration_ms: 100,
      error_clusters: [],
      tool_calls_attempted: 0,
      tool_calls_failed: 0,
      tool_breakage_rate: 0,
      positive_feedback_count: 0,
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
    config: getRuntimeConfig().adaptiveSkills,
  });
  expect(result.action).toBe('keep');

  const latest = getLatestSkillAmendment({
    skillName: context.skillName,
    status: 'applied',
  });
  expect(latest?.metrics_post_apply?.success_rate).toBeCloseTo(1);
});

test('rolls back applied amendments when improvement stays below threshold', async () => {
  context = await createAdaptiveSkillsTestContext();
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
    originalContentHash: sha256('original content\n'),
    proposedContentHash: sha256('amended content\n'),
    rationale: 'Try to improve',
    diffSummary: 'Changed 1 line',
    proposedBy: 'test',
    reviewedBy: 'reviewer',
    guardVerdict: 'safe',
    guardFindingsCount: 0,
    metricsAtProposal: {
      skill_name: context.skillName,
      total_executions: 1,
      success_count: 1,
      partial_count: 0,
      failure_count: 0,
      success_rate: 0.8,
      avg_duration_ms: 100,
      error_clusters: [],
      tool_calls_attempted: 0,
      tool_calls_failed: 0,
      tool_breakage_rate: 0,
      positive_feedback_count: 0,
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
    config: getRuntimeConfig().adaptiveSkills,
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

test('refuses to roll back when the applied skill file was edited manually', async () => {
  context = await createAdaptiveSkillsTestContext();
  const { createSkillAmendment, getSkillAmendmentById } = await import(
    '../src/memory/db.ts'
  );
  const { rollbackAmendment } = await import(
    '../src/skills/skills-evaluation.ts'
  );

  fs.writeFileSync(context.skillFilePath, 'manual edit after apply\n', 'utf-8');

  const amendment = createSkillAmendment({
    skillName: context.skillName,
    skillFilePath: context.skillFilePath,
    status: 'applied',
    originalContent: 'original content\n',
    proposedContent: 'amended content\n',
    originalContentHash: sha256('original content\n'),
    proposedContentHash: sha256('amended content\n'),
    rationale: 'Try to improve',
    diffSummary: '2 line(s) (was 2).',
    proposedBy: 'test',
    reviewedBy: 'reviewer',
    guardVerdict: 'safe',
    guardFindingsCount: 0,
    metricsAtProposal: {
      skill_name: context.skillName,
      total_executions: 1,
      success_count: 1,
      partial_count: 0,
      failure_count: 0,
      success_rate: 0.8,
      avg_duration_ms: 100,
      error_clusters: [],
      tool_calls_attempted: 0,
      tool_calls_failed: 0,
      tool_breakage_rate: 0,
      positive_feedback_count: 0,
      negative_feedback_count: 0,
      degraded: false,
      degradation_reasons: [],
      window_started_at: new Date().toISOString(),
      window_ended_at: new Date().toISOString(),
    },
    runsSinceApply: 3,
  });

  const rollback = await rollbackAmendment({
    amendmentId: amendment.id,
    reason: 'No measurable improvement',
  });

  expect(rollback.ok).toBe(false);
  expect(rollback.reason).toContain(
    'Skill file changed since the amendment was applied.',
  );
  expect(fs.readFileSync(context.skillFilePath, 'utf-8')).toBe(
    'manual edit after apply\n',
  );
  expect(getSkillAmendmentById(amendment.id)?.status).toBe('applied');
});
