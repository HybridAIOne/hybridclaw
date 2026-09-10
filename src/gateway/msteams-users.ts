/**
 * Teams administration exposes only the configured tenant's observed bot users.
 * The HTTP router supplies admin authentication; this service validates agent
 * assignments without changing Teams allowlists or accepting a client tenant ID.
 */
import { getAgentById } from '../agents/agent-registry.js';
import { MSTEAMS_TENANT_ID } from '../config/config.js';
import {
  getRuntimeConfig,
  resolveDefaultAgentId,
} from '../config/runtime-config.js';
import {
  listMSTeamsUsers,
  setMSTeamsUserAgent,
} from '../memory/msteams-users.js';

export function getAdminMSTeamsUsers() {
  return {
    users: listMSTeamsUsers(MSTEAMS_TENANT_ID),
    defaultAgentId: resolveDefaultAgentId(getRuntimeConfig()),
  };
}

export function updateAdminMSTeamsUser(body: unknown): {
  status: number;
  error?: string;
} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, error: 'Expected a user mapping.' };
  }
  const { userId, agentId } = body as Record<string, unknown>;
  if (
    typeof userId !== 'string' ||
    !userId.trim() ||
    (agentId !== null && (typeof agentId !== 'string' || !agentId.trim()))
  ) {
    return {
      status: 400,
      error: 'Provide userId and an agentId, or null to remove the mapping.',
    };
  }
  const target = typeof agentId === 'string' ? agentId.trim() : null;
  if (target) {
    const agent = getAgentById(target);
    if (!agent || agent.archived) {
      return { status: 400, error: 'Select an existing, active agent.' };
    }
  }
  if (!setMSTeamsUserAgent(MSTEAMS_TENANT_ID, userId, target)) {
    return {
      status: 404,
      error: 'Teams user not found in the configured tenant.',
    };
  }
  return { status: 200 };
}
