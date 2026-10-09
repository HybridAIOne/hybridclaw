/**
 * `/approvals rules` — the durable "always allow" grants of the session's
 * agent, and revoking them.
 *
 * A grant comes from answering an approval with `yes for agent` or `yes for
 * all`; the worker keeps them in the agent workspace and reads the files again
 * when they change, so a revoke applies from the next tool call. Only grants
 * are listed: the pinned rules that always ask cannot be granted at all.
 * NOT the network rules of `policy.yaml` (`/policy`) and NOT the approval mode.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  APPROVAL_TRUST_STORE_FILES,
  type ApprovalActionCategory,
  type ApprovalTrustScope,
  type ApprovalTrustStore,
  describeApprovalAction,
  LEGACY_AGENT_TRUST_STORE_FILE,
  parseApprovalTrustStore,
  revokeApprovalTrust,
  serializeApprovalTrustStore,
} from '../../container/shared/approval-rules.js';
import { APPROVALS_RULES_USAGE } from '../approval-commands.js';
import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import type { Session } from '../types/session.js';
import type {
  GatewayCommandRequest,
  GatewayCommandResult,
} from './gateway-types.js';
import { chatSafeJson } from './schedule-command.js';

export interface ApprovalRuleEntry {
  actionKey: string;
  scope: ApprovalTrustScope;
  category: ApprovalActionCategory;
  target?: string;
  label: string;
  /** The approval that created the grant, in the runtime's words. */
  intent?: string;
  grantedAt?: string;
}

const SCOPES: ApprovalTrustScope[] = ['agent', 'all'];

function storePath(workspacePath: string, scope: ApprovalTrustScope): string {
  return path.join(workspacePath, APPROVAL_TRUST_STORE_FILES[scope]);
}

function readStore(
  workspacePath: string,
  scope: ApprovalTrustScope,
): ApprovalTrustStore | null {
  const candidates = [storePath(workspacePath, scope)];
  // The worker moves the legacy file on its next start; until then it counts.
  if (scope === 'agent') {
    candidates.push(path.join(workspacePath, LEGACY_AGENT_TRUST_STORE_FILE));
  }
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      return parseApprovalTrustStore(fs.readFileSync(candidate, 'utf-8'));
    } catch {
      return null;
    }
  }
  return null;
}

function writeStore(
  workspacePath: string,
  scope: ApprovalTrustScope,
  store: ApprovalTrustStore,
): void {
  const target = storePath(workspacePath, scope);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmpPath = `${target}.tmp`;
  fs.writeFileSync(tmpPath, serializeApprovalTrustStore(store), 'utf-8');
  fs.renameSync(tmpPath, target);
}

export function listApprovalRules(workspacePath: string): ApprovalRuleEntry[] {
  const rules: ApprovalRuleEntry[] = [];
  for (const scope of SCOPES) {
    const store = readStore(workspacePath, scope);
    if (!store) continue;
    for (const actionKey of store.actions) {
      const grant = store.grants.find((item) => item.actionKey === actionKey);
      rules.push({
        actionKey,
        scope,
        ...describeApprovalAction(actionKey),
        ...(grant?.intent ? { intent: grant.intent } : {}),
        ...(grant?.grantedAt ? { grantedAt: grant.grantedAt } : {}),
      });
    }
  }
  // Newest first; grants from before dates were kept go last, by name.
  return rules.sort(
    (a, b) =>
      (b.grantedAt || '').localeCompare(a.grantedAt || '') ||
      a.label.localeCompare(b.label),
  );
}

/** Removes the action from every scope that grants it. */
export function revokeApprovalRule(
  workspacePath: string,
  actionKey: string,
): ApprovalTrustScope[] {
  const revoked: ApprovalTrustScope[] = [];
  for (const scope of SCOPES) {
    const store = readStore(workspacePath, scope);
    if (!store) continue;
    const result = revokeApprovalTrust(store, actionKey);
    if (!result.revoked) continue;
    writeStore(workspacePath, scope, result.store);
    revoked.push(scope);
  }
  return revoked;
}

function describeRules(rules: ApprovalRuleEntry[]): string {
  if (rules.length === 0) {
    return 'No "always allow" rules. Answer an approval with `yes for agent` to add one.';
  }
  return rules
    .map((rule, index) => {
      const scope = rule.scope === 'all' ? ' (every agent)' : '';
      const since = rule.grantedAt
        ? `, since ${rule.grantedAt.slice(0, 10)}`
        : '';
      return `${index + 1}. ${rule.label}${scope}${since} — \`${rule.actionKey}\``;
    })
    .join('\n');
}

export function handleApprovalRulesCommand(params: {
  session: Session;
  req: GatewayCommandRequest;
  workspacePath: string;
}): GatewayCommandResult {
  const { session, req, workspacePath } = params;
  const args = req.args.slice(2).map((arg) => String(arg || '').trim());
  const json = args.includes('--json');
  const rest = args.filter((arg) => arg && arg !== '--json');
  const usage: GatewayCommandResult = {
    kind: 'error',
    title: 'Usage',
    text: `Usage: \`${APPROVALS_RULES_USAGE}\``,
  };
  const listed = listApprovalRules(workspacePath);
  if (rest.length === 0) {
    return json
      ? { kind: 'plain', text: chatSafeJson({ version: 1, rules: listed }) }
      : { kind: 'info', title: 'Always Allow', text: describeRules(listed) };
  }
  if (rest[0].toLowerCase() !== 'revoke' || rest.length !== 2) return usage;
  const named = rest[1];
  const index = /^\d+$/.test(named) ? Number(named) - 1 : -1;
  const actionKey = index >= 0 ? listed[index]?.actionKey : named;
  if (!actionKey) return usage;
  const scopes = revokeApprovalRule(workspacePath, actionKey);
  if (scopes.length > 0) {
    recordAuditEvent({
      sessionId: session.id,
      runId: makeAuditRunId('approval-trust'),
      event: {
        type: 'approval.trust_revoked',
        action_key: actionKey,
        scopes,
        user_id: req.userId ?? null,
        channel_id: req.channelId,
      },
    });
  }
  const remaining = listApprovalRules(workspacePath);
  if (json) {
    return {
      kind: 'plain',
      text: chatSafeJson({
        version: 1,
        revoked: scopes.length > 0,
        rules: remaining,
      }),
    };
  }
  if (scopes.length === 0) {
    return {
      kind: 'error',
      title: 'Always Allow',
      text: `No "always allow" rule for \`${actionKey}\`.`,
    };
  }
  return {
    kind: 'info',
    title: 'Always Allow',
    text: `Revoked \`${actionKey}\`; it asks again from the next tool call.\n\n${describeRules(remaining)}`,
  };
}
