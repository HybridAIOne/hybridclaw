/**
 * Session approval mode — the stored `ask | auto | full` choice and the
 * effective mode a turn runs with.
 *
 * A running `/fullauto` loop always runs in `full`; otherwise the stored mode
 * applies. Only a human command changes it, and every change is audited.
 * NOT the approval pipeline (`container/src/approval-policy.ts` applies the
 * mode) and NOT `/approve`, which answers a single pending request.
 */
import {
  APPROVAL_MODE_PRESENTATION,
  type ApprovalMode,
  DEFAULT_APPROVAL_MODE,
  isApprovalMode,
} from '../../container/shared/approval-mode.js';
import {
  APPROVALS_MODE_USAGE,
  APPROVALS_RULES_USAGE,
} from '../approval-commands.js';
import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import { updateSessionApprovalMode } from '../memory/db.js';
import type { Session } from '../types/session.js';
import { handleApprovalRulesCommand } from './approval-rules-command.js';
import { isFullAutoEnabled } from './fullauto-runtime.js';
import type {
  GatewayCommandRequest,
  GatewayCommandResult,
} from './gateway-types.js';

export function resolveSessionApprovalMode(session: Session): ApprovalMode {
  if (isFullAutoEnabled(session)) return 'full';
  return isApprovalMode(session.approval_mode)
    ? session.approval_mode
    : DEFAULT_APPROVAL_MODE;
}

function describeMode(session: Session, mode: ApprovalMode): string {
  const { label, description } = APPROVAL_MODE_PRESENTATION[mode];
  const lines = [`Current: ${mode} (${label})`, description];
  if (isFullAutoEnabled(session) && session.approval_mode !== 'full') {
    lines.push(
      'Full-auto is running, so approvals stay in full access until `/fullauto off`.',
    );
  }
  return lines.join('\n');
}

function modeResult(session: Session, json: boolean): GatewayCommandResult {
  const mode = resolveSessionApprovalMode(session);
  return json
    ? { kind: 'plain', text: JSON.stringify({ approvalMode: mode }) }
    : {
        kind: 'info',
        title: 'Approval Mode',
        text: describeMode(session, mode),
      };
}

export function handleApprovalsCommand(params: {
  session: Session;
  req: GatewayCommandRequest;
  /** The session agent's workspace, where its "always allow" grants live. */
  workspacePath: string;
}): GatewayCommandResult {
  const { session, req } = params;
  const sub = (req.args[1] || '').trim().toLowerCase();
  const usage = `Usage: \`${APPROVALS_MODE_USAGE}\` or \`${APPROVALS_RULES_USAGE}\``;
  if (sub === 'rules') {
    return handleApprovalRulesCommand(params);
  }
  if (sub !== 'mode') {
    return { kind: 'error', title: 'Usage', text: usage };
  }
  const json = req.args.includes('--json');
  const next = (req.args.slice(2).find((arg) => arg !== '--json') || '')
    .trim()
    .toLowerCase();
  if (!next) {
    return modeResult(session, json);
  }
  if (!isApprovalMode(next)) {
    return { kind: 'error', title: 'Usage', text: usage };
  }
  const previous = session.approval_mode;
  if (previous !== next) {
    updateSessionApprovalMode(session.id, next);
    recordAuditEvent({
      sessionId: session.id,
      runId: makeAuditRunId('approval-mode'),
      event: {
        type: 'approval.mode_changed',
        from: previous,
        to: next,
        user_id: req.userId ?? null,
        channel_id: req.channelId,
      },
    });
  }
  const updated: Session = { ...session, approval_mode: next };
  return modeResult(updated, json);
}
