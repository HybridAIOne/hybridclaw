/**
 * Teams administration exposes only the configured tenant's observed bot users.
 * The HTTP router supplies admin authentication; this service validates agent
 * assignments without changing Teams allowlists or accepting a client tenant ID.
 */
import { getAgentById } from '../agents/agent-registry.js';
import { createPersonalAgent } from '../agents/personal-agent.js';
import { buildMSTeamsUserMarkdown } from '../channels/msteams/user-routing.js';
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
  const config = getRuntimeConfig();
  return {
    users: listMSTeamsUsers(MSTEAMS_TENANT_ID),
    defaultAgentId: resolveDefaultAgentId(config),
    personalAgentParent: config.msteams.personalAgentParent || null,
  };
}

export function createAdminMSTeamsPersonalAgent(body: unknown): {
  status: number;
  error?: string;
  agentId?: string;
} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, error: 'Expected a userId and parentAgentId.' };
  }
  const { userId, parentAgentId } = body as Record<string, unknown>;
  if (
    typeof userId !== 'string' ||
    !userId.trim() ||
    typeof parentAgentId !== 'string' ||
    !parentAgentId.trim()
  ) {
    return { status: 400, error: 'Expected a userId and parentAgentId.' };
  }
  const user = listMSTeamsUsers(MSTEAMS_TENANT_ID).find(
    (entry) => entry.userId === userId.trim(),
  );
  if (!user) {
    return {
      status: 404,
      error: 'Teams user not found in the configured tenant.',
    };
  }
  const parent = getAgentById(parentAgentId.trim());
  if (!parent || parent.archived || parent.extends) {
    return {
      status: 400,
      error: 'Select an existing, active agent that is not itself personal.',
    };
  }
  const created = createPersonalAgent({
    parentAgentId: parent.id,
    handle: user.displayName || user.userId,
    displayName: `${parent.displayName || parent.name || parent.id} · ${user.displayName || user.userId}`,
    userMarkdown: buildMSTeamsUserMarkdown(user),
  });
  setMSTeamsUserAgent(MSTEAMS_TENANT_ID, user.userId, created.id);
  return { status: 200, agentId: created.id };
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
