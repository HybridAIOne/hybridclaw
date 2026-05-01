import { normalizeTrimmedString } from '../utils/normalized-strings.js';
import { type AgentConfig, DEFAULT_AGENT_ID } from './agent-types.js';

type AgentReference = AgentConfig | string | null | undefined;

function agentReferenceId(agent: AgentReference): string {
  if (!agent) return DEFAULT_AGENT_ID;
  return (
    normalizeTrimmedString(typeof agent === 'string' ? agent : agent.id) ||
    DEFAULT_AGENT_ID
  );
}

function agentById(
  agents: readonly AgentConfig[],
  agent: AgentReference,
): AgentConfig | null {
  const agentId = agentReferenceId(agent);
  return agents.find((entry) => entry.id === agentId) ?? null;
}

export function hasAgentReference(
  values: readonly string[] | undefined,
  agentId: string,
): boolean {
  return (
    values?.some((value) => normalizeTrimmedString(value) === agentId) ?? false
  );
}

function pushUniqueAgent(
  result: AgentConfig[],
  seen: Set<string>,
  agent: AgentConfig | null,
): void {
  if (!agent || seen.has(agent.id)) return;
  seen.add(agent.id);
  result.push(agent);
}

export function managerOf(
  coworker: AgentReference,
  agents: readonly AgentConfig[],
): AgentConfig | null {
  const agent = agentById(agents, coworker);
  if (!agent) return null;
  const managerId = normalizeTrimmedString(agent.reportsTo);
  if (!managerId) return null;
  return agents.find((entry) => entry.id === managerId) ?? null;
}

export function peersOf(
  coworker: AgentReference,
  agents: readonly AgentConfig[],
): AgentConfig[] {
  const agent = agentById(agents, coworker);
  if (!agent) return [];
  const peerIds = agent.peers ?? [];
  const peers: AgentConfig[] = [];
  const seen = new Set<string>([agent.id]);

  for (const peerId of peerIds) {
    pushUniqueAgent(
      peers,
      seen,
      agents.find((entry) => entry.id === normalizeTrimmedString(peerId)) ??
        null,
    );
  }

  for (const candidate of agents) {
    if (candidate.id === agent.id) continue;
    if (hasAgentReference(candidate.peers, agent.id)) {
      pushUniqueAgent(peers, seen, candidate);
    }
  }

  return peers;
}

export function escalationChain(
  coworker: AgentReference,
  agents: readonly AgentConfig[],
): AgentConfig[] {
  const chain: AgentConfig[] = [];
  const seen = new Set<string>();
  let current = managerOf(coworker, agents);

  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    current = managerOf(current, agents);
  }

  return chain;
}
