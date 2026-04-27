import { recordAuditEvent } from '../audit/audit-events.js';
import { getRuntimeConfig } from '../config/runtime-config.js';
import { logger } from '../logger.js';
import {
  attachFeedbackToObservation,
  getSkillObservations,
  incrementAmendmentRunCount,
  recordSkillObservation as insertSkillObservation,
  recomputeAgentSkillScore,
} from '../memory/db.js';
import type { ToolExecution } from '../types/execution.js';
import type { TokenUsageStats } from '../types/usage.js';
import type {
  AdaptiveSkillsConfig,
  SkillErrorCategory,
  SkillExecutionOutcome,
  SkillFeedbackSentiment,
  SkillObservation,
} from './adaptive-skills-types.js';
import {
  refreshAgentCv,
  refreshAgentCvForSkillRun,
} from './agent-scoreboard.js';
import {
  buildSkillRunBoundedPayload,
  buildSkillRunTokens,
  emitSkillRunEvent,
  type SkillRunEvent,
  subscribeSkillRunEvents,
  summarizeSkillRunToolExecutions,
} from './skill-run-events.js';
import { evaluateAmendment, rollbackAmendment } from './skills-evaluation.js';

let queuedSkillEvaluationWork: Promise<void> = Promise.resolve();

function getToolExecutionErrorDetail(execution: ToolExecution): string | null {
  return (
    execution.blockedReason?.trim() ||
    execution.approvalReason?.trim() ||
    execution.result?.trim() ||
    null
  );
}

function firstFailedToolDetail(toolExecutions: ToolExecution[]): string | null {
  for (const execution of toolExecutions) {
    if (!execution.isError && !execution.blocked) continue;
    const detail = getToolExecutionErrorDetail(execution);
    if (detail) return detail;
  }
  return null;
}

export function classifyErrorCategory(
  toolExecutions: ToolExecution[],
  agentError?: string | null,
): SkillErrorCategory | null {
  const normalizedError = String(agentError || '')
    .trim()
    .toLowerCase();
  if (
    toolExecutions.some((execution) => execution.isError || execution.blocked)
  ) {
    return 'tool_error';
  }
  if (!normalizedError) return null;
  if (
    normalizedError.includes('timed out') ||
    normalizedError.includes('timeout')
  ) {
    return 'timeout';
  }
  if (
    normalizedError.includes('aborted') ||
    normalizedError.includes('cancelled') ||
    normalizedError.includes('canceled') ||
    normalizedError.includes('user stopped')
  ) {
    return 'user_abort';
  }
  if (
    normalizedError.includes('enoent') ||
    normalizedError.includes('workspace reset') ||
    normalizedError.includes('no such file') ||
    normalizedError.includes('environment changed')
  ) {
    return 'env_changed';
  }
  return 'model_error';
}

export function deriveSkillExecutionOutcome(params: {
  outputStatus: 'success' | 'error';
  toolExecutions: ToolExecution[];
}): SkillExecutionOutcome {
  if (params.outputStatus === 'error') return 'failure';
  if (
    params.toolExecutions.some(
      (execution) => execution.isError || execution.blocked,
    )
  ) {
    return 'partial';
  }
  return 'success';
}

function queueSkillEvaluation(input: {
  config: AdaptiveSkillsConfig;
  skillName: string;
}): void {
  const work = queuedSkillEvaluationWork.then(async () => {
    try {
      const evaluation = evaluateAmendment({
        skillName: input.skillName,
        config: input.config,
      });
      if (evaluation.action === 'rollback' && evaluation.amendmentId) {
        await rollbackAmendment({
          amendmentId: evaluation.amendmentId,
          reason: evaluation.reason,
        });
      }
    } catch (error) {
      logger.warn(
        { skillName: input.skillName, error },
        'Failed to evaluate adaptive skill amendment after execution',
      );
    }
  });
  queuedSkillEvaluationWork = work.catch(() => {});
}

function recordSkillExecutionObservation(
  event: SkillRunEvent,
): SkillObservation | null {
  const config = getRuntimeConfig().adaptiveSkills;
  if (!config.observationEnabled) return null;

  const observation = insertSkillObservation({
    skillName: event.skill_id,
    agentId: event.agent_id,
    sessionId: event.session_id,
    runId: event.run_id,
    outcome: event.outcome,
    errorCategory: event.error_category,
    errorDetail: event.error_detail,
    toolCallsAttempted: event.tool_executions.length,
    toolCallsFailed: event.tool_executions.filter(
      (execution) => execution.is_error || execution.blocked,
    ).length,
    durationMs: event.latency_ms,
  });

  if (event.agent_id) {
    recomputeAgentSkillScore({
      agentId: event.agent_id,
      skillId: event.skill_id,
    });
  }

  recordAuditEvent({
    sessionId: event.session_id,
    runId: event.run_id,
    event: {
      type: 'skill.execution',
      skillName: event.skill_id,
      outcome: observation.outcome,
      errorCategory: observation.error_category,
      toolCallsAttempted: observation.tool_calls_attempted,
      toolCallsFailed: observation.tool_calls_failed,
      durationMs: observation.duration_ms,
    },
  });

  if (!config.enabled) return observation;

  const applied = incrementAmendmentRunCount(event.skill_id);
  if (!applied) return observation;

  queueSkillEvaluation({ skillName: event.skill_id, config });
  return observation;
}

export async function waitForQueuedSkillEvaluations(): Promise<void> {
  await queuedSkillEvaluationWork;
}

subscribeSkillRunEvents(recordSkillExecutionObservation);
subscribeSkillRunEvents(refreshAgentCvForSkillRun);

function collectSkillRunErrors(input: {
  errorDetail?: string | null;
  toolExecutions: ToolExecution[];
}): string[] {
  const errors = new Set<string>();
  const errorDetail = input.errorDetail?.trim();
  if (errorDetail) errors.add(errorDetail);
  for (const execution of input.toolExecutions) {
    if (!execution.isError && !execution.blocked) continue;
    const detail = getToolExecutionErrorDetail(execution);
    if (detail) errors.add(detail);
  }
  return [...errors];
}

function normalizeSkillRunCostUsd(costUsd?: number | null): number {
  if (costUsd == null) return 0;
  if (Number.isFinite(costUsd) && costUsd >= 0) return costUsd;
  logger.warn(
    { costUsd },
    'Invalid skill run cost value; recording zero cost in event',
  );
  return 0;
}

export function recordSkillExecution(input: {
  skillName: string;
  sessionId: string;
  runId: string;
  toolExecutions: ToolExecution[];
  outcome: SkillExecutionOutcome;
  durationMs: number;
  model?: string | null;
  tokenUsage?: TokenUsageStats;
  costUsd?: number | null;
  agentId?: string | null;
  input?: unknown;
  output?: unknown;
  errorCategory?: SkillErrorCategory | null;
  errorDetail?: string | null;
}): SkillObservation | null {
  const skillName = input.skillName.trim();
  if (!skillName) return null;

  const errorCategory =
    input.errorCategory ??
    classifyErrorCategory(input.toolExecutions, input.errorDetail);
  const errorDetail =
    input.errorDetail?.trim() || firstFailedToolDetail(input.toolExecutions);
  const event: SkillRunEvent = {
    type: 'skill_run',
    skill_id: skillName,
    agent_id: input.agentId?.trim() || null,
    session_id: input.sessionId,
    run_id: input.runId,
    input: buildSkillRunBoundedPayload(input.input),
    output: buildSkillRunBoundedPayload(input.output),
    model: input.model?.trim() || null,
    tokens: buildSkillRunTokens(input.tokenUsage),
    latency_ms: input.durationMs,
    cost_usd: normalizeSkillRunCostUsd(input.costUsd),
    errors: collectSkillRunErrors({
      errorDetail,
      toolExecutions: input.toolExecutions,
    }),
    outcome: input.outcome,
    error_category: errorCategory,
    error_detail: errorDetail,
    tool_executions: summarizeSkillRunToolExecutions(input.toolExecutions),
  };

  emitSkillRunEvent(event);
  return (
    getSkillObservations({
      skillName,
      sessionId: input.sessionId,
      runId: input.runId,
      limit: 1,
    })[0] ?? null
  );
}

export function recordSkillFeedback(input: {
  sessionId: string;
  feedback: string;
  sentiment: SkillFeedbackSentiment;
}): SkillObservation | null {
  const config = getRuntimeConfig().adaptiveSkills;
  if (!config.observationEnabled) return null;
  const observation = attachFeedbackToObservation({
    sessionId: input.sessionId,
    feedback: input.feedback,
    sentiment: input.sentiment,
  });
  if (observation?.agent_id) {
    try {
      recomputeAgentSkillScore({
        agentId: observation.agent_id,
        skillId: observation.skill_name,
      });
      refreshAgentCv(observation.agent_id);
    } catch (error) {
      logger.warn(
        {
          agentId: observation.agent_id,
          sessionId: observation.session_id,
          runId: observation.run_id,
          error,
        },
        'Failed to refresh agent CV after skill feedback',
      );
    }
  }
  return observation;
}
