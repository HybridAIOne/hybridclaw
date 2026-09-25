/**
 * Teams user routing selects an existing agent within the configured tenant.
 * It runs after channel access checks and never treats a mapping as permission.
 * Personal agents (children via `extends`) answer only in direct chats; in
 * group chats and channel threads their parent answers, so one shared
 * conversation never mixes several people's private agents. Without a
 * configured tenant (multi-tenant bot) routing always picks the default agent.
 * Session construction stays with inbound.ts; unavailable mappings fail closed.
 */
import { getAgentById } from '../../agents/agent-registry.js';
import { createPersonalAgent } from '../../agents/personal-agent.js';
import {
  getRuntimeConfig,
  resolveDefaultAgentId,
} from '../../config/runtime-config.js';
import { logger } from '../../logger.js';
import {
  getMSTeamsUserAgent,
  getMSTeamsUserMapping,
  setMSTeamsUserAgent,
} from '../../memory/msteams-users.js';
import type { MSTeamsConversationKind } from './inbound.js';

export function resolveMSTeamsUserAgent(
  tenantId: string,
  userId: string,
  conversationKind: MSTeamsConversationKind = 'personal',
): string {
  const agentId = tenantId.trim()
    ? getMSTeamsUserAgent(tenantId, userId)
    : null;
  if (!agentId) return resolveDefaultAgentId(getRuntimeConfig());
  const agent = getAgentById(agentId);
  if (!agent || agent.archived) {
    throw new Error(
      'The agent assigned to your Teams account is unavailable. Ask an administrator to update your Teams user mapping.',
    );
  }
  if (agent.extends && conversationKind !== 'personal') {
    const parent = getAgentById(agent.extends);
    if (parent && !parent.archived) return parent.id;
  }
  return agent.id;
}

export interface MSTeamsPersonalAgentSeed {
  tenantId: string;
  userId: string;
  displayName: string | null;
  entraObjectId: string | null;
  teamsUserId: string | null;
}

export function buildMSTeamsUserMarkdown(
  seed: MSTeamsPersonalAgentSeed,
): string {
  const lines = [
    '# USER.md',
    '',
    `- Name: ${seed.displayName || 'Unknown'}`,
    '- Channel: Microsoft Teams',
    ...(seed.entraObjectId ? [`- Entra object ID: ${seed.entraObjectId}`] : []),
    ...(seed.teamsUserId ? [`- Teams user ID: ${seed.teamsUserId}`] : []),
    '',
    'This agent works for this one person. Learn their preferences here.',
    '',
  ];
  return lines.join('\n');
}

/**
 * Create and map a personal agent for an observed Teams sender. Returns the
 * agent id, or null when provisioning is off, the sender was never observed,
 * or a mapping already exists.
 */
export function ensureMSTeamsPersonalAgent(
  seed: MSTeamsPersonalAgentSeed,
): string | null {
  const parentAgentId = getRuntimeConfig().msteams.personalAgentParent.trim();
  if (!parentAgentId || !seed.tenantId.trim()) return null;
  const mapping = getMSTeamsUserMapping(seed.tenantId, seed.userId);
  if (!mapping || mapping.agentId) return null;
  const parent = getAgentById(parentAgentId);
  const created = createPersonalAgent({
    parentAgentId,
    handle: seed.displayName || seed.userId,
    displayName: `${parent?.displayName || parent?.name || parentAgentId} · ${seed.displayName || seed.userId}`,
    userMarkdown: buildMSTeamsUserMarkdown(seed),
  });
  setMSTeamsUserAgent(seed.tenantId, seed.userId, created.id);
  logger.info(
    { agentId: created.id, parentAgentId },
    'Created personal Teams agent',
  );
  return created.id;
}
