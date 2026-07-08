import { findAgentConfig, listAgents } from '../agents/agent-registry.js';
import type { AgentConfig } from '../agents/agent-types.js';
import {
  deriveLocalAgentIdentity,
  parseAgentIdentity,
  resolveLocalInstanceId,
} from '../identity/agent-id.js';
import { logger } from '../logger.js';
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

function resolveLocalAgentOwnerFallback(agent: AgentConfig): string {
  if (agent.owner) return agent.owner;
  if (process.env.HYBRIDCLAW_USER_ID) return process.env.HYBRIDCLAW_USER_ID;

  const osOwner = process.env.USER || process.env.LOGNAME || '';
  if (osOwner) {
    logger.warn(
      { agentId: agent.id },
      'Deriving transient local agent identity from OS user environment',
    );
  }
  return osOwner;
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
  if (agent.canonicalId) {
    try {
      return parseAgentIdentity(agent.canonicalId).id;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new A2AEnvelopeValidationError([
        `canonical id for local agent ${agent.id} is invalid: ${detail}`,
      ]);
    }
  }

  return deriveLocalAgentIdentity({
    agentId: agent.id,
    owner: resolveLocalAgentOwnerFallback(agent),
    ownerUserId: agent.ownerUserId,
    instanceId: resolveLocalInstanceId(),
  }).canonicalId;
}

export function resolveLocalA2AAgentId(agentId: string): string | null {
  const normalized = agentId.trim();
  const kind = classifyA2AAgentId(normalized);
  if (kind === 'local') {
    try {
      return findLocalAgent(normalized).id;
    } catch {
      return null;
    }
  }
  if (kind !== 'canonical') return null;

  const canonicalAgentId = parseAgentIdentity(normalized).id;
  for (const agent of listAgents()) {
    try {
      if (resolveA2AAgentId(agent.id) === canonicalAgentId) {
        return agent.id;
      }
    } catch {
      // Agent registry validation owns surfacing malformed local records.
    }
  }
  return null;
}

export function isLocalA2AAgentId(agentId: string): boolean {
  const normalized = agentId.trim();
  const kind = classifyA2AAgentId(normalized);
  if (kind === 'local') return resolveLocalA2AAgentId(normalized) !== null;
  if (kind !== 'canonical') return false;

  const parsed = parseAgentIdentity(normalized);
  if (resolveLocalA2AAgentId(parsed.id)) return true;
  return parsed.instanceId === resolveLocalInstanceId();
}

export function resolveA2AEnvelopeAgentIds(envelope: unknown): A2AEnvelope {
  const normalizedEnvelope = validateA2AEnvelope(envelope);
  const senderAgentId = resolveA2AAgentId(normalizedEnvelope.sender_agent_id);
  const recipientAgentId = resolveA2AAgentId(
    normalizedEnvelope.recipient_agent_id,
  );
  return {
    ...normalizedEnvelope,
    sender_agent_id: senderAgentId,
    recipient_agent_id: recipientAgentId,
    sender_instance_id: parseAgentIdentity(senderAgentId).instanceId,
  };
}
