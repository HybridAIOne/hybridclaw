import {
  AGENT_GRANT_SOURCES,
  type AgentGrant,
  type AgentGrantSource,
  listAgentGrants,
} from '../agents/agent-grants.js';
import { getAgentById } from '../agents/agent-registry.js';
import { shareAgent, unshareAgent } from '../agents/agent-sharing.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';

export interface GatewayAdminAgentGrantsResponse {
  grants: AgentGrant[];
}

function requireAgent(agentId: string): string {
  const normalizedAgentId = agentId.trim();
  if (!normalizedAgentId || !getAgentById(normalizedAgentId)) {
    throw new GatewayRequestError(
      404,
      `Agent "${normalizedAgentId || agentId}" was not found.`,
    );
  }
  return normalizedAgentId;
}

function normalizeSource(value: unknown): AgentGrantSource | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new GatewayRequestError(
      400,
      '`source` must be `local` or `platform`.',
    );
  }
  const source = value.trim();
  if (!AGENT_GRANT_SOURCES.includes(source as AgentGrantSource)) {
    throw new GatewayRequestError(
      400,
      '`source` must be `local` or `platform`.',
    );
  }
  return source as AgentGrantSource;
}

function normalizeOptionalDateInput(
  value: unknown,
  field: 'syncedAt' | 'expiresAt',
): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string') {
    throw new GatewayRequestError(
      400,
      `\`${field}\` must be an ISO date or null.`,
    );
  }
  return value;
}

export function getGatewayAdminAgentGrants(
  agentId: string,
): GatewayAdminAgentGrantsResponse {
  return { grants: listAgentGrants(requireAgent(agentId)) };
}

export function shareGatewayAdminAgent(input: {
  agentId: string;
  principal: unknown;
  source?: unknown;
  syncedAt?: unknown;
  expiresAt?: unknown;
  grantedBy: string;
}): { grant: AgentGrant } {
  return {
    grant: shareAgent({
      agentId: requireAgent(input.agentId),
      principal: input.principal,
      source: normalizeSource(input.source),
      grantedBy: input.grantedBy,
      syncedAt: normalizeOptionalDateInput(input.syncedAt, 'syncedAt'),
      expiresAt: normalizeOptionalDateInput(input.expiresAt, 'expiresAt'),
    }),
  };
}

export function unshareGatewayAdminAgent(input: {
  agentId: string;
  principal: unknown;
  revokedBy: string;
}): { grant: AgentGrant; removed: true } {
  const agentId = requireAgent(input.agentId);
  const grant = unshareAgent({
    agentId,
    principal: input.principal,
    revokedBy: input.revokedBy,
  });
  if (!grant) {
    throw new GatewayRequestError(404, 'Agent grant was not found.');
  }
  return { grant, removed: true };
}
