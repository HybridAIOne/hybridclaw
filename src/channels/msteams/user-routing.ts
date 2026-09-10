/**
 * Teams user routing selects an existing agent within the configured tenant.
 * It runs after channel access checks and never treats a mapping as permission.
 * Session construction stays with inbound.ts; unavailable mappings fail closed.
 */
import { getAgentById } from '../../agents/agent-registry.js';
import {
  getRuntimeConfig,
  resolveDefaultAgentId,
} from '../../config/runtime-config.js';
import { getMSTeamsUserAgent } from '../../memory/msteams-users.js';

export function resolveMSTeamsUserAgent(
  tenantId: string,
  userId: string,
): string {
  const agentId = getMSTeamsUserAgent(tenantId, userId);
  if (!agentId) return resolveDefaultAgentId(getRuntimeConfig());
  const agent = getAgentById(agentId);
  if (!agent || agent.archived) {
    throw new Error(
      'The agent assigned to your Teams account is unavailable. Ask an administrator to update your Teams user mapping.',
    );
  }
  return agent.id;
}
