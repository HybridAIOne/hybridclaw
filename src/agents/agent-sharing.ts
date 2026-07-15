import {
  makeAuditRunId,
  recordAuditEventStrict,
} from '../audit/audit-events.js';
import { tryNormalizePrincipal } from '../identity/principal.js';
import { withMemoryDatabase } from '../memory/db.js';
import {
  type AgentGrant,
  deleteAgentGrant,
  type UpsertAgentGrantInput,
  upsertAgentGrant,
} from './agent-grants.js';

export function agentGrantAuditSessionId(agentId: string): string {
  return `agent-grants:${agentId.trim()}`;
}

function auditActor(
  grantedBy: string,
): { type: 'user'; id: string } | undefined {
  const id = tryNormalizePrincipal(grantedBy);
  return id ? { type: 'user', id } : undefined;
}

function recordGrantAudit(
  type: 'agent.shared' | 'agent.unshared',
  grant: AgentGrant,
  actorValue: string,
): void {
  const actor = auditActor(actorValue);
  recordAuditEventStrict({
    sessionId: agentGrantAuditSessionId(grant.agent_id),
    runId: makeAuditRunId(
      type === 'agent.shared' ? 'agent-share' : 'agent-unshare',
    ),
    event: {
      type,
      ...(actor ? { actor } : {}),
      targetAgentId: grant.agent_id,
      principal: grant.principal,
      role: grant.role,
      source: grant.source,
      grantedBy: grant.granted_by,
      grantedAt: grant.granted_at,
      syncedAt: grant.synced_at,
      expiresAt: grant.expires_at,
      ...(type === 'agent.unshared' ? { revokedBy: actorValue } : {}),
    },
  });
}

export function shareAgent(input: UpsertAgentGrantInput): AgentGrant {
  return withMemoryDatabase((database) =>
    database.transaction(() => {
      const grant = upsertAgentGrant(input);
      recordGrantAudit('agent.shared', grant, input.grantedBy);
      return grant;
    })(),
  );
}

export function unshareAgent(input: {
  agentId: string;
  principal: unknown;
  revokedBy: string;
  now?: Date;
}): AgentGrant | null {
  return withMemoryDatabase((database) =>
    database.transaction(() => {
      const grant = deleteAgentGrant(input.agentId, input.principal, {
        now: input.now,
      });
      if (grant) recordGrantAudit('agent.unshared', grant, input.revokedBy);
      return grant;
    })(),
  );
}
