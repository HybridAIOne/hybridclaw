import type { EscalationTarget } from '../types/execution.js';
import {
  normalizeTrimmedString,
  normalizeTrimmedUniqueStringArray,
} from '../utils/normalized-strings.js';

export type { EscalationTarget as AgentEscalationTarget } from '../types/execution.js';
export {
  escalationTargetEquals as agentEscalationTargetEquals,
  normalizeEscalationTarget as normalizeAgentEscalationTarget,
} from '../types/execution.js';

export const DEFAULT_AGENT_ID = 'main';

export type AgentModelConfig =
  | string
  | {
      primary: string;
      fallbacks?: string[];
    };

export interface AgentCv {
  summary?: string;
  background?: string;
  capabilities?: string[];
  asset?: string;
}

export interface AgentConfig {
  id: string;
  name?: string;
  displayName?: string;
  imageAsset?: string;
  model?: AgentModelConfig;
  skills?: string[];
  workspace?: string;
  chatbotId?: string;
  enableRag?: boolean;
  owner?: string;
  role?: string;
  reportsTo?: string;
  delegatesTo?: string[];
  peers?: string[];
  cv?: AgentCv;
  escalationTarget?: EscalationTarget;
}

export interface AgentDefaultsConfig {
  model?: AgentModelConfig;
  chatbotId?: string;
  enableRag?: boolean;
}

export interface AgentsConfig {
  defaultAgentId?: string;
  defaults?: AgentDefaultsConfig;
  list?: AgentConfig[];
}

export function buildOptionalAgentPresentation(
  displayName?: string | null,
  imageAsset?: string | null,
): Pick<AgentConfig, 'displayName' | 'imageAsset'> {
  return {
    ...(displayName ? { displayName } : {}),
    ...(imageAsset ? { imageAsset } : {}),
  };
}

export function normalizeAgentCv(value: unknown): AgentCv | undefined {
  if (typeof value === 'string') {
    const asset = normalizeTrimmedString(value);
    return asset ? { asset } : undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as {
    summary?: unknown;
    background?: unknown;
    capabilities?: unknown;
    asset?: unknown;
  };
  const summary = normalizeTrimmedString(raw.summary);
  const background = normalizeTrimmedString(raw.background);
  const asset = normalizeTrimmedString(raw.asset);
  const capabilities = Array.isArray(raw.capabilities)
    ? normalizeTrimmedUniqueStringArray(raw.capabilities)
    : [];
  const cv: AgentCv = {
    ...(summary ? { summary } : {}),
    ...(background ? { background } : {}),
    ...(capabilities.length > 0 ? { capabilities } : {}),
    ...(asset ? { asset } : {}),
  };
  return Object.keys(cv).length > 0 ? cv : undefined;
}

export function cloneAgentCv(value: AgentCv | undefined): AgentCv | undefined {
  if (!value) return undefined;
  return {
    ...value,
    ...(value.capabilities ? { capabilities: [...value.capabilities] } : {}),
  };
}

export function agentCvEquals(a?: AgentCv, b?: AgentCv): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.summary !== b.summary) return false;
  if (a.background !== b.background) return false;
  if (a.asset !== b.asset) return false;
  const aCaps = a.capabilities ?? [];
  const bCaps = b.capabilities ?? [];
  if (aCaps.length !== bCaps.length) return false;
  return aCaps.every((entry, index) => entry === bCaps[index]);
}

export function hasSnakeCamelAlias(
  value: object,
  camelKey: string,
  snakeKey: string,
): boolean {
  return resolveSnakeCamelAlias(value, camelKey, snakeKey) !== undefined;
}

export function resolveSnakeCamelAlias(
  value: object,
  camelKey: string,
  snakeKey: string,
): unknown {
  const record = value as Record<string, unknown>;
  return record[camelKey] !== undefined ? record[camelKey] : record[snakeKey];
}

export function validateAgentOrgChart(agents: AgentConfig[]): void {
  const agentIds = new Set<string>();
  for (const agent of agents) {
    agentIds.add(agent.id);
  }

  const reportsToByAgent = new Map<string, string>();
  for (const agent of agents) {
    const reportsTo = normalizeTrimmedString(agent.reportsTo);
    if (!reportsTo) continue;
    if (!agentIds.has(reportsTo)) {
      throw new Error(
        `Agent "${agent.id}" reports_to references unknown agent "${reportsTo}".`,
      );
    }
    // Keep the direct self-reference error clearer than the generic DFS cycle.
    if (reportsTo === agent.id) {
      throw new Error(
        `Agent "${agent.id}" reports_to cannot reference itself.`,
      );
    }
    reportsToByAgent.set(agent.id, reportsTo);
  }

  // Delegation and peer links are graph edges, not a management tree. Validate
  // targets here; traversal code must still keep its own visited set.
  for (const agent of agents) {
    for (const delegateId of agent.delegatesTo ?? []) {
      const normalizedDelegateId = normalizeTrimmedString(delegateId);
      if (!normalizedDelegateId) continue;
      if (!agentIds.has(normalizedDelegateId)) {
        throw new Error(
          `Agent "${agent.id}" delegates_to references unknown agent "${normalizedDelegateId}".`,
        );
      }
    }
    for (const peerId of agent.peers ?? []) {
      const normalizedPeerId = normalizeTrimmedString(peerId);
      if (!normalizedPeerId) continue;
      if (!agentIds.has(normalizedPeerId)) {
        throw new Error(
          `Agent "${agent.id}" peers references unknown agent "${normalizedPeerId}".`,
        );
      }
    }
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();

  const visit = (agentId: string, path: string[]): void => {
    if (visited.has(agentId)) return;
    if (visiting.has(agentId)) {
      const cycleStart = path.indexOf(agentId);
      const cyclePath = path.slice(Math.max(cycleStart, 0)).join(' -> ');
      throw new Error(`Agent reports_to cycle detected: ${cyclePath}.`);
    }

    visiting.add(agentId);
    const parentId = reportsToByAgent.get(agentId);
    if (parentId) {
      visit(parentId, [...path, parentId]);
    }
    visiting.delete(agentId);
    visited.add(agentId);
  };

  for (const agentId of reportsToByAgent.keys()) {
    visit(agentId, [agentId]);
  }
}
