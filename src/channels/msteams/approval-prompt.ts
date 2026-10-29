/**
 * Teams approvals show one decision and only the scopes the runtime permits.
 * The stored prompt remains available for review; this view neither interprets
 * consent nor changes approval policy, unlike the worker's approval runtime.
 */
import {
  type ApprovalPauseCause,
  parseApprovalRule,
} from '../../../container/shared/approval-rules.js';
import type { PendingApproval } from '../../types/execution.js';

const PAUSE_EXPLANATIONS: Record<ApprovalPauseCause, string> = {
  risky: 'This action may have lasting effects, so I need your permission.',
  ask_mode: 'Your settings require me to ask before continuing.',
  protected: 'This action affects a protected item and needs your permission.',
  unusual: 'This action is unusual for this task and needs your permission.',
  workspace_policy: 'Your workspace rules require permission for this action.',
};

function plainApprovalText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/[\\`*_{}[\]()#+!|>~-]/g, '\\$&')
    .replace(/^(\d+)\./, '$1\\.')
    .replace(/\bwww\./gi, 'www&#46;')
    .replace(/@/g, '&#64;')
    .replace(/:/g, '&#58;');
}

export function formatMSTeamsApprovalPrompt(
  approval: PendingApproval,
  now = Date.now(),
): string {
  // Boosts ask whether to spend a credit, rather than authorize a tool action.
  if (approval.boost) return approval.prompt;

  const rule = parseApprovalRule(approval.rule);
  const intent = approval.intent.trim();
  const includesCommand =
    approval.commandPreview && intent.includes(approval.commandPreview);
  const action = includesCommand ? rule?.label : intent || rule?.label;
  if (!action && !approval.commandPreview?.trim()) return approval.prompt;
  const explanation = rule
    ? PAUSE_EXPLANATIONS[rule.pausedBy]
    : approval.reason.trim();
  const replies = ['- `1` — Allow this action once'];
  if (approval.allowSession === true) {
    replies.push('- `2` — Allow this kind of action for this chat session');
  }
  if (approval.allowAgent === true) {
    replies.push('- `3` — Always allow this kind of action for this assistant');
  }
  if (approval.allowAll === true) {
    replies.push('- `4` — Always allow this kind of action for all assistants');
  }
  replies.push('- `5` — Deny this action', '- `0` — Show details');

  const lines = [
    '**Permission needed**',
    action ? plainApprovalText(action) : '',
    plainApprovalText(explanation),
    `**Reply with a number:**\n${replies.join('\n')}`,
  ].filter(Boolean);
  if (
    typeof approval.expiresAt === 'number' &&
    Number.isFinite(approval.expiresAt)
  ) {
    const seconds = Math.max(0, Math.ceil((approval.expiresAt - now) / 1_000));
    lines.push(
      seconds > 0
        ? `Please reply within ${seconds} ${seconds === 1 ? 'second' : 'seconds'}. Without approval, this action will not run.`
        : 'This request has expired. Ask me to try again if you still want to continue.',
    );
  }
  return lines.join('\n\n');
}
