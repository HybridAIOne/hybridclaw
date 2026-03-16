import fs from 'node:fs';
import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import {
  getLatestSkillAmendment,
  getSkillAmendmentById,
  updateAmendmentStatus,
} from '../memory/db.js';
import type { SkillCogneeConfig } from './skills-cognee-types.js';
import { inspectSkill } from './skills-inspection.js';

export function evaluateAmendment(input: {
  skillName: string;
  config: SkillCogneeConfig;
}):
  | {
      action: 'keep';
      reason: string;
      amendmentId: number;
    }
  | {
      action: 'rollback';
      reason: string;
      amendmentId: number;
    }
  | {
      action: 'insufficient_data';
      reason: string;
      amendmentId?: number;
    } {
  const amendment = getLatestSkillAmendment({
    skillName: input.skillName,
    status: 'applied',
  });
  if (!amendment) {
    return {
      action: 'insufficient_data',
      reason: 'No applied amendment found.',
    };
  }
  if (amendment.runs_since_apply < input.config.evaluationRunsBeforeRollback) {
    return {
      action: 'insufficient_data',
      reason: `Need ${input.config.evaluationRunsBeforeRollback} runs before evaluation; have ${amendment.runs_since_apply}.`,
      amendmentId: amendment.id,
    };
  }

  const baseline = amendment.metrics_at_proposal;
  if (!baseline) {
    return {
      action: 'insufficient_data',
      reason: 'Applied amendment is missing proposal metrics.',
      amendmentId: amendment.id,
    };
  }

  const currentMetrics = inspectSkill(input.skillName, input.config);
  const improvement = currentMetrics.success_rate - baseline.success_rate;
  if (improvement < input.config.rollbackImprovementThreshold) {
    return {
      action: 'rollback',
      reason: `Success rate improvement ${improvement.toFixed(2)} is below required ${input.config.rollbackImprovementThreshold.toFixed(2)}.`,
      amendmentId: amendment.id,
    };
  }

  updateAmendmentStatus({
    amendmentId: amendment.id,
    status: 'applied',
    metricsPostApply: currentMetrics,
    resetRunsSinceApply: false,
  });
  return {
    action: 'keep',
    reason: `Success rate improved by ${improvement.toFixed(2)}.`,
    amendmentId: amendment.id,
  };
}

export async function rollbackAmendment(input: {
  amendmentId: number;
  reason: string;
}): Promise<{ ok: boolean; reason?: string }> {
  const amendment = getSkillAmendmentById(input.amendmentId);
  if (!amendment) {
    return { ok: false, reason: 'Amendment not found.' };
  }
  if (amendment.status !== 'applied') {
    return { ok: false, reason: 'Only applied amendments can be rolled back.' };
  }

  fs.writeFileSync(
    amendment.skill_file_path,
    amendment.original_content,
    'utf-8',
  );
  updateAmendmentStatus({
    amendmentId: amendment.id,
    status: 'rolled_back',
    metricsPostApply: inspectSkill(amendment.skill_name),
  });
  recordAuditEvent({
    sessionId: `cognee:${amendment.skill_name}`,
    runId: makeAuditRunId('skill-amendment'),
    event: {
      type: 'skill.amendment.rolled_back',
      skillName: amendment.skill_name,
      amendmentId: amendment.id,
      version: amendment.version,
      reason: input.reason,
    },
  });
  return { ok: true };
}
