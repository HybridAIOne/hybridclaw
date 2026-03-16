import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import {
  getAmendmentHistory,
  getLatestSkillAmendment,
  getSkillObservations,
} from '../memory/db.js';
import type {
  SkillAmendment,
  SkillHealthMetrics,
  SkillObservation,
} from './adaptive-skills-types.js';
import { loadSkillCatalog, type SkillCatalogEntry } from './skills.js';
import {
  applyAmendment,
  proposeAmendment,
  rejectAmendment,
} from './skills-amendment.js';
import { rollbackAmendment } from './skills-evaluation.js';
import { inspectAllSkills, inspectSkill } from './skills-inspection.js';
import { resolveSkillInstallId } from './skills-install.js';

export interface SkillCatalogInstallEntry {
  id: string;
  kind: string;
  label: string;
}

export interface SkillCatalogSummaryEntry extends SkillCatalogEntry {
  installs: SkillCatalogInstallEntry[];
}

export type SkillAmendmentCommandAction =
  | 'propose'
  | 'apply'
  | 'reject'
  | 'rollback';

export type SkillAmendmentCommandResult =
  | {
      ok: true;
      action: 'proposed';
      skillName: string;
      amendment: SkillAmendment;
      metrics: SkillHealthMetrics;
    }
  | {
      ok: true;
      action: 'applied' | 'rejected' | 'rolled_back';
      skillName: string;
      amendment: SkillAmendment;
    }
  | {
      ok: false;
      action: SkillAmendmentCommandAction;
      skillName: string;
      error:
        | 'no_observations'
        | 'no_staged_amendment'
        | 'no_applied_amendment'
        | 'apply_failed'
        | 'reject_failed'
        | 'rollback_failed';
      message: string;
    };

export function listSkillCatalogEntries(): SkillCatalogSummaryEntry[] {
  return loadSkillCatalog().map((skill) => ({
    ...skill,
    installs: (skill.metadata.hybridclaw.install || []).map((spec, index) => ({
      id: resolveSkillInstallId(spec, index),
      kind: spec.kind,
      label: spec.label || '',
    })),
  }));
}

export function inspectObservedSkill(skillName: string): SkillHealthMetrics {
  return inspectSkill(skillName);
}

export function inspectObservedSkills(): SkillHealthMetrics[] {
  return inspectAllSkills();
}

export function getSkillAmendmentHistory(skillName: string): SkillAmendment[] {
  return getAmendmentHistory(skillName);
}

export function getSkillExecutionRuns(
  skillName: string,
  limit = 10,
): SkillObservation[] {
  return getSkillObservations({
    skillName,
    limit,
  });
}

export async function runSkillAmendmentCommand(input: {
  skillName: string;
  action: SkillAmendmentCommandAction;
  reviewedBy: string;
  agentId?: string;
  rollbackReason: string;
}): Promise<SkillAmendmentCommandResult> {
  const skillName = input.skillName.trim();
  if (input.action === 'apply') {
    const amendment = getLatestSkillAmendment({
      skillName,
      status: 'staged',
    });
    if (!amendment) {
      return {
        ok: false,
        action: 'apply',
        skillName,
        error: 'no_staged_amendment',
        message: `No staged amendment found for "${skillName}".`,
      };
    }
    const result = await applyAmendment({
      amendmentId: amendment.id,
      reviewedBy: input.reviewedBy,
    });
    if (!result.ok) {
      return {
        ok: false,
        action: 'apply',
        skillName,
        error: 'apply_failed',
        message: result.reason || 'Failed to apply amendment.',
      };
    }
    return {
      ok: true,
      action: 'applied',
      skillName,
      amendment,
    };
  }

  if (input.action === 'reject') {
    const amendment = getLatestSkillAmendment({
      skillName,
      status: 'staged',
    });
    if (!amendment) {
      return {
        ok: false,
        action: 'reject',
        skillName,
        error: 'no_staged_amendment',
        message: `No staged amendment found for "${skillName}".`,
      };
    }
    const result = rejectAmendment({
      amendmentId: amendment.id,
      reviewedBy: input.reviewedBy,
    });
    if (!result.ok) {
      return {
        ok: false,
        action: 'reject',
        skillName,
        error: 'reject_failed',
        message: result.reason || 'Failed to reject amendment.',
      };
    }
    return {
      ok: true,
      action: 'rejected',
      skillName,
      amendment,
    };
  }

  if (input.action === 'rollback') {
    const amendment = getLatestSkillAmendment({
      skillName,
      status: 'applied',
    });
    if (!amendment) {
      return {
        ok: false,
        action: 'rollback',
        skillName,
        error: 'no_applied_amendment',
        message: `No applied amendment found for "${skillName}".`,
      };
    }
    const result = await rollbackAmendment({
      amendmentId: amendment.id,
      reason: input.rollbackReason,
    });
    if (!result.ok) {
      return {
        ok: false,
        action: 'rollback',
        skillName,
        error: 'rollback_failed',
        message: result.reason || 'Failed to roll back amendment.',
      };
    }
    return {
      ok: true,
      action: 'rolled_back',
      skillName,
      amendment,
    };
  }

  const metrics = inspectSkill(skillName);
  if (metrics.total_executions === 0) {
    return {
      ok: false,
      action: 'propose',
      skillName,
      error: 'no_observations',
      message: `No observations found for "${skillName}"; run the skill first before proposing an amendment.`,
    };
  }
  const amendment = await proposeAmendment({
    skillName,
    metrics,
    agentId: input.agentId || DEFAULT_AGENT_ID,
  });
  return {
    ok: true,
    action: 'proposed',
    skillName,
    amendment,
    metrics,
  };
}
