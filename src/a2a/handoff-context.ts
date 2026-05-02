import { listAgents } from '../agents/agent-registry.js';
import type { AgentConfig } from '../agents/agent-types.js';
import { escalationChain, managerOf, peersOf } from '../agents/org-chart.js';
import { resolveA2AAgentId } from './identity.js';
import { isRecord } from './utils.js';

const HANDOFF_ORG_CHART_CONTEXT_HEADING = '## Handoff Org Chart Context';
const HANDOFF_ORG_CHART_CONTEXT_MARKER =
  '<!-- hybridclaw:a2a-handoff-org-chart-context:v1 -->';

function agentMatchesA2AId(agent: AgentConfig, agentId: string): boolean {
  const normalized = agentId.trim();
  if (!normalized) return false;
  if (
    agent.id === normalized ||
    agent.id.toLowerCase() === normalized.toLowerCase()
  ) {
    return true;
  }
  if (!normalized.includes('@')) return false;
  try {
    return resolveA2AAgentId(agent.id) === normalized.toLowerCase();
  } catch {
    return false;
  }
}

function resolveLocalAgent(
  agentId: string,
  agents: readonly AgentConfig[],
): AgentConfig | null {
  return agents.find((agent) => agentMatchesA2AId(agent, agentId)) ?? null;
}

function formatAgentReference(agent: AgentConfig | null | undefined): string {
  if (!agent) return 'none';
  const role = agent.role?.replace(/\s+/g, ' ').trim();
  return `${agent.id}${role ? ` (${role})` : ''}`;
}

function formatAgentReferences(
  agents: readonly AgentConfig[],
  separator: string,
): string {
  if (agents.length === 0) return 'none';
  return agents.map((agent) => formatAgentReference(agent)).join(separator);
}

export function formatA2AHandoffOrgChartContext(params: {
  senderAgentId: string;
  recipientAgentId: string;
}): string {
  const agents = listAgents();
  const sender = resolveLocalAgent(params.senderAgentId, agents);
  const recipient = resolveLocalAgent(params.recipientAgentId, agents);
  const senderId = sender?.id ?? params.senderAgentId;
  const recipientId = recipient?.id ?? params.recipientAgentId;
  return [
    HANDOFF_ORG_CHART_CONTEXT_MARKER,
    HANDOFF_ORG_CHART_CONTEXT_HEADING,
    `sender_manager: ${formatAgentReference(managerOf(senderId, agents))}`,
    `recipient_manager: ${formatAgentReference(managerOf(recipientId, agents))}`,
    `recipient_peers: ${formatAgentReferences(
      peersOf(recipientId, agents),
      ', ',
    )}`,
    `recipient_escalation_chain: ${formatAgentReferences(
      escalationChain(recipientId, agents),
      ' -> ',
    )}`,
  ].join('\n');
}

export function attachA2AHandoffContext(envelope: unknown): unknown {
  if (!isRecord(envelope)) return envelope;
  if (envelope.intent !== 'handoff') return envelope;
  if (
    typeof envelope.sender_agent_id !== 'string' ||
    typeof envelope.recipient_agent_id !== 'string' ||
    typeof envelope.content !== 'string'
  ) {
    return envelope;
  }
  if (envelope.content.includes(HANDOFF_ORG_CHART_CONTEXT_MARKER)) {
    return envelope;
  }
  return {
    ...envelope,
    content: [
      envelope.content.trimEnd(),
      '',
      formatA2AHandoffOrgChartContext({
        senderAgentId: envelope.sender_agent_id,
        recipientAgentId: envelope.recipient_agent_id,
      }),
    ].join('\n'),
  };
}
