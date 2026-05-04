import { findAgentConfig, listAgents } from '../agents/agent-registry.js';
import { type AgentConfig, DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import {
  formatAgentIdentity,
  resolveLocalInstanceId,
  slugifyAgentIdentityComponent,
} from '../identity/agent-id.js';
import {
  type A2AEnvelope,
  A2AEnvelopeValidationError,
  classifyA2AAgentId,
  validateA2AEnvelope,
} from './envelope.js';

function findLocalAgent(agentId: string): AgentConfig {
  const exact = findAgentConfig(agentId);
  if (exact) return exact;

  const normalized = agentId.toLowerCase();
  const matches = listAgents().filter(
    (agent) => agent.id.toLowerCase() === normalized,
  );
  if (matches.length === 1 && matches[0]) return matches[0];
  if (matches.length > 1) {
    throw new A2AEnvelopeValidationError([
      `local agent id ${agentId} is ambiguous`,
    ]);
  }
  throw new A2AEnvelopeValidationError([
    `local agent id ${agentId} does not match a registered agent`,
  ]);
}

export function resolveA2AAgentId(agentId: string): string {
  const normalized = agentId.trim();
  const kind = classifyA2AAgentId(normalized);
  if (kind === 'canonical') return normalized.toLowerCase();
  if (kind !== 'local') {
    throw new A2AEnvelopeValidationError([
      'agent id must be a local agent id or canonical agent id (agent-slug@user@instance-id)',
    ]);
  }

  const agent = findLocalAgent(normalized);
  const agentSlug = slugifyAgentIdentityComponent(agent.id, DEFAULT_AGENT_ID);
  const userSlug = slugifyAgentIdentityComponent(
    agent.owner ||
      process.env.HYBRIDCLAW_USER_ID ||
      process.env.USER ||
      process.env.LOGNAME ||
      '',
    'local',
  );
  return formatAgentIdentity(agentSlug, userSlug, resolveLocalInstanceId());
}

export function resolveA2AEnvelopeAgentIds(envelope: unknown): A2AEnvelope {
  const normalizedEnvelope = validateA2AEnvelope(envelope);
  return {
    ...normalizedEnvelope,
    sender_agent_id: resolveA2AAgentId(normalizedEnvelope.sender_agent_id),
    recipient_agent_id: resolveA2AAgentId(
      normalizedEnvelope.recipient_agent_id,
    ),
  };
}
