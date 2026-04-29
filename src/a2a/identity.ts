import { createHash } from 'node:crypto';
import os from 'node:os';

import { findAgentConfig, listAgents } from '../agents/agent-registry.js';
import { type AgentConfig, DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-paths.js';
import {
  type A2AEnvelope,
  A2AEnvelopeValidationError,
  classifyA2AAgentId,
  validateA2AEnvelope,
} from './envelope.js';

const CANONICAL_COMPONENT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
let cachedInstanceId: string | undefined;

function canonicalComponent(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/@.*$/u, '')
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^[._-]+|[._-]+$/gu, '')
    .slice(0, 128);
  if (normalized && CANONICAL_COMPONENT_PATTERN.test(normalized)) {
    return normalized;
  }
  return fallback;
}

function readEnvInstanceId(): string {
  return canonicalComponent(process.env.HYBRIDCLAW_INSTANCE_ID || '', '');
}

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

export function resolveLocalA2AInstanceId(): string {
  if (cachedInstanceId) return cachedInstanceId;

  const envInstanceId = readEnvInstanceId();
  if (envInstanceId) {
    cachedInstanceId = envInstanceId;
    return envInstanceId;
  }

  const digest = createHash('sha256')
    .update(os.hostname(), 'utf-8')
    .update('\0')
    .update(DEFAULT_RUNTIME_HOME_DIR, 'utf-8')
    .digest('hex')
    .slice(0, 12);
  cachedInstanceId = `local-${digest}`;
  return cachedInstanceId;
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
  const agentSlug = canonicalComponent(agent.id, DEFAULT_AGENT_ID);
  const userSlug = canonicalComponent(
    agent.owner ||
      process.env.HYBRIDCLAW_USER_ID ||
      process.env.USER ||
      process.env.LOGNAME ||
      '',
    'local',
  );
  return `${agentSlug}@${userSlug}@${resolveLocalA2AInstanceId()}`;
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
