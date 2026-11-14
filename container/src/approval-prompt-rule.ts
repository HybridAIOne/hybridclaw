/**
 * Prompt creation and learning observations preserve the classifier's decision.
 * Learning suppresses prompts and implicit waits, never policy denials or trust
 * boundaries. Unlike approval-policy, this module does not classify actions.
 * A full-auto collision recovery denies one call before creating a prompt;
 * it never executes that call or grants consent for a later retry.
 */
import type { ApprovalMode } from '@hybridclaw/shared/approval-mode';
import type {
  ToolApprovalEvaluation,
  ToolCallContext,
} from './approval-policy.js';
import { FILE_WRITE_CONFLICT_ACTION_PREFIX } from './file-write-conflicts.js';

export function observeLearningApproval(
  evaluation: ToolApprovalEvaluation,
  mode: ApprovalMode,
): ToolApprovalEvaluation {
  if (
    mode !== 'learning' ||
    (evaluation.decision !== 'required' && evaluation.decision !== 'implicit')
  )
    return evaluation;
  return {
    ...evaluation,
    approvalObservation: {
      decision: evaluation.decision,
      tier: evaluation.tier,
      pinned: evaluation.pinned,
      reason: evaluation.reason,
    },
    decision: 'auto',
    escalationRoute: 'none',
    implicitDelayMs: undefined,
    requestId: undefined,
    expiresAtMs: undefined,
  };
}

export function resolveApprovalQueue(
  context: ToolCallContext,
  evaluation: ToolApprovalEvaluation,
): ToolApprovalEvaluation | null {
  const observed = observeLearningApproval(
    evaluation,
    context.helpers.approvalMode(),
  );
  if (observed.approvalObservation) return observed;
  if (context.helpers.getPendingCount() < context.policy.maxPendingApprovals)
    return null;
  return {
    ...evaluation,
    decision: 'denied',
    escalationRoute: 'policy_denial',
    consequenceIfDenied:
      'If this is denied, I will continue with non-destructive alternatives only.',
    reason: `Approval queue is full (${context.policy.maxPendingApprovals} pending).`,
  };
}

export function resolveApprovalPrompt(
  context: ToolCallContext,
  evaluation: ToolApprovalEvaluation,
): ToolApprovalEvaluation {
  const observed = observeLearningApproval(
    evaluation,
    context.helpers.approvalMode(),
  );
  if (observed.approvalObservation) return observed;
  if (
    context.helpers.approvalMode() === 'full' &&
    context.params.fileWriteReplanAvailable === true &&
    evaluation.actionKey.startsWith(FILE_WRITE_CONFLICT_ACTION_PREFIX)
  ) {
    return {
      ...evaluation,
      decision: 'denied',
      escalationRoute: 'policy_denial',
    };
  }
  if (context.helpers.approvalUserIsBot() && !context.escalationTarget) {
    return {
      ...evaluation,
      decision: 'denied',
      escalationRoute: 'policy_denial',
      reason:
        'another bot or a webhook started this turn, so no person can approve this step',
    };
  }
  const request = context.helpers.getOrCreatePending({
    fingerprint: evaluation.fingerprint,
    actionKey: evaluation.actionKey,
    toolName: context.params.toolName,
    argsJson: context.params.argsJson,
    intent: evaluation.intent,
    consequenceIfDenied: evaluation.consequenceIfDenied,
    reason: evaluation.reason,
    commandPreview: evaluation.commandPreview,
    originalPrompt: context.params.latestUserPrompt,
    pinned: evaluation.pinned,
  });
  return {
    ...evaluation,
    requestId: request.id,
    expiresAtMs: request.expiresAtMs,
  };
}
