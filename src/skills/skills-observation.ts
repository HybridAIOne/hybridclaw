import { recordAuditEvent } from '../audit/audit-events.js';
import { getRuntimeConfig } from '../config/runtime-config.js';
import { logger } from '../logger.js';
import {
  attachFeedbackToObservation,
  incrementAmendmentRunCount,
  recordSkillObservation as insertSkillObservation,
} from '../memory/db.js';
import type { ToolExecution } from '../types/execution.js';
import type {
  AdaptiveSkillsConfig,
  SkillErrorCategory,
  SkillExecutionOutcome,
  SkillFeedbackSentiment,
  SkillObservation,
} from './adaptive-skills-types.js';
import { evaluateAmendment, rollbackAmendment } from './skills-evaluation.js';

let queuedSkillEvaluationWork: Promise<void> = Promise.resolve();

function firstFailedToolDetail(toolExecutions: ToolExecution[]): string | null {
  for (const execution of toolExecutions) {
    if (!execution.isError && !execution.blocked) continue;
    const detail =
      execution.blockedReason?.trim() ||
      execution.approvalReason?.trim() ||
      execution.result?.trim() ||
      null;
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

export async function waitForQueuedSkillEvaluations(): Promise<void> {
  await queuedSkillEvaluationWork;
}

export function recordSkillExecution(input: {
  skillName: string;
  sessionId: string;
  runId: string;
  toolExecutions: ToolExecution[];
  outcome: SkillExecutionOutcome;
  durationMs: number;
  errorCategory?: SkillErrorCategory | null;
  errorDetail?: string | null;
}): SkillObservation | null {
  const config = getRuntimeConfig().adaptiveSkills;
  const skillName = input.skillName.trim();
  if (!skillName || !config.observationEnabled) return null;

  const errorCategory =
    input.errorCategory ??
    classifyErrorCategory(input.toolExecutions, input.errorDetail);
  const errorDetail =
    input.errorDetail?.trim() || firstFailedToolDetail(input.toolExecutions);
  const observation = insertSkillObservation({
    skillName,
    sessionId: input.sessionId,
    runId: input.runId,
    outcome: input.outcome,
    errorCategory,
    errorDetail,
    toolCallsAttempted: input.toolExecutions.length,
    toolCallsFailed: input.toolExecutions.filter(
      (execution) => execution.isError || execution.blocked,
    ).length,
    durationMs: input.durationMs,
  });

  recordAuditEvent({
    sessionId: input.sessionId,
    runId: input.runId,
    event: {
      type: 'skill.execution',
      skillName,
      outcome: observation.outcome,
      errorCategory: observation.error_category,
      toolCallsAttempted: observation.tool_calls_attempted,
      toolCallsFailed: observation.tool_calls_failed,
      durationMs: observation.duration_ms,
    },
  });

  if (!config.enabled) return observation;

  const applied = incrementAmendmentRunCount(skillName);
  if (!applied) return observation;

  queueSkillEvaluation({ skillName, config });
  return observation;
}

export function recordSkillFeedback(input: {
  sessionId: string;
  feedback: string;
  sentiment: SkillFeedbackSentiment;
}): SkillObservation | null {
  const config = getRuntimeConfig().adaptiveSkills;
  if (!config.observationEnabled) return null;
  return attachFeedbackToObservation({
    sessionId: input.sessionId,
    feedback: input.feedback,
    sentiment: input.sentiment,
  });
}
