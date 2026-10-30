/**
 * Approval explanations retain classifier, policy-pinning and anomaly reasons.
 * Unlike approval policy, this formatter never selects a tier or grants access;
 * it does not inspect the protected content that triggered a rule.
 */
import type { ClassifiedAction, ToolCallContext } from './approval-policy.js';

export function approvalReason(
  context: ToolCallContext,
  classified: ClassifiedAction,
): string {
  return [
    classified.reason,
    ...(context.pinnedByPolicy === true
      ? [
          'this action matches a pinned-sensitive approval rule and requires one-time approval',
        ]
      : []),
    ...(context.anomalyElevated && context.anomaly
      ? [context.anomaly.reason]
      : []),
  ].join('; ');
}
