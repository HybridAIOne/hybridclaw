import {
  escalationChainForAgent,
  managerOfAgent,
  peersOfAgent,
} from '../agents/agent-registry.js';
import type { AgentConfig } from '../agents/agent-types.js';
import { isRecord } from './utils.js';

const HANDOFF_ORG_CHART_CONTEXT_HEADING = '## Handoff Org Chart Context';

function localAgentId(agentId: string): string {
  return agentId.trim().replace(/@.*$/u, '');
}

function formatAgentReference(agent: AgentConfig | null | undefined): string {
  if (!agent) return 'none';
  const role = agent.role ? ` (${agent.role})` : '';
  return `${agent.id}${role}`;
}

function formatAgentReferences(agents: readonly AgentConfig[]): string {
  if (agents.length === 0) return 'none';
  return agents.map((agent) => formatAgentReference(agent)).join(' -> ');
}

export function formatA2AHandoffOrgChartContext(params: {
  senderAgentId: string;
  recipientAgentId: string;
}): string {
  const senderAgentId = localAgentId(params.senderAgentId);
  const recipientAgentId = localAgentId(params.recipientAgentId);
  return [
    HANDOFF_ORG_CHART_CONTEXT_HEADING,
    `sender_manager: ${formatAgentReference(managerOfAgent(senderAgentId))}`,
    `sender_peers: ${formatAgentReferences(peersOfAgent(senderAgentId))}`,
    `sender_escalation_chain: ${formatAgentReferences(
      escalationChainForAgent(senderAgentId),
    )}`,
    `recipient_manager: ${formatAgentReference(
      managerOfAgent(recipientAgentId),
    )}`,
    `recipient_peers: ${formatAgentReferences(peersOfAgent(recipientAgentId))}`,
    `recipient_escalation_chain: ${formatAgentReferences(
      escalationChainForAgent(recipientAgentId),
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
  if (envelope.content.includes(HANDOFF_ORG_CHART_CONTEXT_HEADING)) {
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
