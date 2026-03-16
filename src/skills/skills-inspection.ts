import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import { getRuntimeConfig } from '../config/runtime-config.js';
import { logger } from '../logger.js';
import {
  getLatestSkillAmendment,
  getMemoryValue,
  getObservedSkillNames,
  getSkillObservationSummary,
  pruneSkillObservations,
  setMemoryValue,
} from '../memory/db.js';
import type {
  AdaptiveSkillsConfig,
  SkillHealthMetrics,
} from './adaptive-skills-types.js';
import { applyAmendment, proposeAmendment } from './skills-amendment.js';

const LAST_INSPECTION_KEY = 'adaptive-skills:last-inspection-at';
const LAST_OBSERVATION_PRUNE_KEY = 'adaptive-skills:last-observation-prune-at';
const queuedSkillAmendments = new Set<string>();
let queuedSkillAmendmentWork: Promise<void> = Promise.resolve();

function resolveConfig(config?: AdaptiveSkillsConfig): AdaptiveSkillsConfig {
  return config || getRuntimeConfig().adaptiveSkills;
}

function windowStartIso(config: AdaptiveSkillsConfig): string {
  return new Date(
    Date.now() - config.trailingWindowHours * 60 * 60 * 1000,
  ).toISOString();
}

function observationRetentionCutoffIso(
  config: AdaptiveSkillsConfig,
): string | null {
  if (config.observationRetentionDays <= 0) return null;
  return new Date(
    Date.now() - config.observationRetentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();
}

function shouldRunScheduledWork(
  agentId: string,
  key: string,
  intervalMs: number,
  now: number,
): boolean {
  const lastRunRaw = getMemoryValue(agentId, key);
  const lastRunMs =
    typeof lastRunRaw === 'string' ? Date.parse(lastRunRaw) : Number.NaN;
  if (Number.isFinite(lastRunMs) && now - lastRunMs < intervalMs) {
    return false;
  }
  setMemoryValue(agentId, key, new Date(now).toISOString());
  return true;
}

function runObservationPruneIfDue(
  agentId: string,
  config: AdaptiveSkillsConfig,
  now: number,
): number {
  const cutoffIso = observationRetentionCutoffIso(config);
  if (!cutoffIso || !config.observationEnabled) return 0;
  if (
    !shouldRunScheduledWork(
      agentId,
      LAST_OBSERVATION_PRUNE_KEY,
      config.inspectionIntervalMs,
      now,
    )
  ) {
    return 0;
  }
  return pruneSkillObservations({ createdBefore: cutoffIso });
}

function inspectionSeverity(metrics: SkillHealthMetrics): number {
  if (!metrics.degraded) return 0;
  return (
    metrics.degradation_reasons.length * 100 +
    Math.round((1 - metrics.success_rate) * 100) +
    Math.round(metrics.tool_breakage_rate * 100)
  );
}

function queueSkillAmendmentProposal(input: {
  agentId: string;
  config: AdaptiveSkillsConfig;
  metrics: SkillHealthMetrics;
}): void {
  const queueKey = `${input.agentId}:${input.metrics.skill_name}`;
  if (queuedSkillAmendments.has(queueKey)) {
    return;
  }
  queuedSkillAmendments.add(queueKey);

  const work = queuedSkillAmendmentWork.then(async () => {
    try {
      const latest = getLatestSkillAmendment({
        skillName: input.metrics.skill_name,
      });
      if (latest?.status === 'staged' || latest?.status === 'applied') {
        return;
      }

      const amendment = await proposeAmendment({
        skillName: input.metrics.skill_name,
        metrics: input.metrics,
        agentId: input.agentId,
      });
      if (
        input.config.autoApplyEnabled &&
        amendment.guard_verdict === 'safe' &&
        amendment.guard_findings_count === 0
      ) {
        await applyAmendment({
          amendmentId: amendment.id,
          reviewedBy: 'adaptive-skills:auto',
        });
      }
    } catch (error) {
      logger.warn(
        { skillName: input.metrics.skill_name, error },
        'Failed to propose skill amendment during periodic inspection',
      );
    } finally {
      queuedSkillAmendments.delete(queueKey);
    }
  });

  queuedSkillAmendmentWork = work.catch(() => {});
}

export async function waitForQueuedSkillAmendments(): Promise<void> {
  await queuedSkillAmendmentWork;
}

export function isDegraded(
  metrics: SkillHealthMetrics,
  config: AdaptiveSkillsConfig,
): { degraded: boolean; reasons: string[] } {
  if (metrics.total_executions < config.minExecutionsForInspection) {
    return {
      degraded: false,
      reasons: [],
    };
  }

  const reasons: string[] = [];
  if (metrics.success_rate < config.degradationSuccessRateThreshold) {
    reasons.push(
      `success rate ${metrics.success_rate.toFixed(2)} below ${config.degradationSuccessRateThreshold.toFixed(2)}`,
    );
  }
  if (metrics.tool_breakage_rate > config.degradationToolBreakageThreshold) {
    reasons.push(
      `tool breakage ${metrics.tool_breakage_rate.toFixed(2)} above ${config.degradationToolBreakageThreshold.toFixed(2)}`,
    );
  }
  const negativeFeedbackSpikeThreshold = Math.max(
    2,
    Math.ceil(metrics.total_executions * 0.25),
  );
  if (metrics.negative_feedback_count >= negativeFeedbackSpikeThreshold) {
    reasons.push(
      `negative feedback spike (${metrics.negative_feedback_count} in window)`,
    );
  }
  return {
    degraded: reasons.length > 0,
    reasons,
  };
}

export function inspectSkill(
  skillName: string,
  config?: AdaptiveSkillsConfig,
): SkillHealthMetrics {
  const resolvedConfig = resolveConfig(config);
  const start = windowStartIso(resolvedConfig);
  const summary = getSkillObservationSummary({
    skillName,
    createdAfter: start,
  })[0];

  const base: SkillHealthMetrics = {
    skill_name: skillName,
    total_executions: summary?.total_executions || 0,
    success_rate:
      summary && summary.total_executions > 0
        ? summary.success_count / summary.total_executions
        : 0,
    avg_duration_ms: summary?.avg_duration_ms || 0,
    error_clusters: summary?.error_clusters || [],
    tool_breakage_rate:
      summary && summary.tool_calls_attempted > 0
        ? summary.tool_calls_failed / summary.tool_calls_attempted
        : 0,
    positive_feedback_count: summary?.positive_feedback_count || 0,
    negative_feedback_count: summary?.negative_feedback_count || 0,
    degraded: false,
    degradation_reasons: [],
    window_started_at: start,
    window_ended_at: new Date().toISOString(),
  };
  const degradation = isDegraded(base, resolvedConfig);
  return {
    ...base,
    degraded: degradation.degraded,
    degradation_reasons: degradation.reasons,
  };
}

export function inspectAllSkills(
  config?: AdaptiveSkillsConfig,
): SkillHealthMetrics[] {
  const resolvedConfig = resolveConfig(config);
  return getObservedSkillNames({
    createdAfter: windowStartIso(resolvedConfig),
  })
    .map((skillName) => inspectSkill(skillName, resolvedConfig))
    .sort((left, right) => {
      const severityDiff = inspectionSeverity(right) - inspectionSeverity(left);
      if (severityDiff !== 0) return severityDiff;
      return left.skill_name.localeCompare(right.skill_name);
    });
}

export async function runPeriodicSkillInspection(input?: {
  agentId?: string;
  config?: AdaptiveSkillsConfig;
}): Promise<SkillHealthMetrics[]> {
  const config = resolveConfig(input?.config);
  const agentId = input?.agentId || DEFAULT_AGENT_ID;
  const now = Date.now();
  const prunedObservations = runObservationPruneIfDue(agentId, config, now);
  if (prunedObservations > 0) {
    logger.info(
      { prunedObservations },
      'Pruned expired adaptive skill observations',
    );
  }

  if (!config.enabled) return [];

  if (
    !shouldRunScheduledWork(
      agentId,
      LAST_INSPECTION_KEY,
      config.inspectionIntervalMs,
      now,
    )
  ) {
    return [];
  }
  const metricsList = inspectAllSkills(config);
  const sessionId = `adaptive-skills:${agentId}`;
  const runId = makeAuditRunId('skill-inspection');

  for (const metrics of metricsList) {
    recordAuditEvent({
      sessionId,
      runId,
      event: {
        type: 'skill.inspection',
        skillName: metrics.skill_name,
        totalExecutions: metrics.total_executions,
        successRate: metrics.success_rate,
        avgDurationMs: metrics.avg_duration_ms,
        toolBreakageRate: metrics.tool_breakage_rate,
        positiveFeedbackCount: metrics.positive_feedback_count,
        negativeFeedbackCount: metrics.negative_feedback_count,
        degraded: metrics.degraded,
        degradationReasons: metrics.degradation_reasons,
      },
    });
    if (!metrics.degraded) continue;

    const latest = getLatestSkillAmendment({ skillName: metrics.skill_name });
    if (latest?.status === 'staged' || latest?.status === 'applied') {
      continue;
    }

    queueSkillAmendmentProposal({
      agentId,
      config,
      metrics,
    });
  }

  return metricsList;
}
