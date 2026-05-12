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
      fallbacks?: string[] | undefined;
    };

export interface AgentCv {
  summary?: string | undefined;
  background?: string | undefined;
  capabilities?: string[] | undefined;
  asset?: string | undefined;
}

export type AgentA2AExposure = 'public' | 'trusted' | 'private';

export interface AgentA2AConfig {
  exposure?: AgentA2AExposure | undefined;
  skillExposure?: Record<string, AgentA2AExposure> | undefined;
}

export interface AgentConfig {
  id: string;
  name?: string | undefined;
  displayName?: string | undefined;
  imageAsset?: string | undefined;
  model?: AgentModelConfig | undefined;
  skills?: string[] | undefined;
  workspace?: string | undefined;
  chatbotId?: string | undefined;
  enableRag?: boolean | undefined;
  owner?: string | undefined;
  role?: string | undefined;
  reportsTo?: string | undefined;
  delegatesTo?: string[] | undefined;
  peers?: string[] | undefined;
  cv?: AgentCv | undefined;
  escalationTarget?: EscalationTarget | undefined;
  a2a?: AgentA2AConfig | undefined;
}

export interface AgentDefaultsConfig {
  model?: AgentModelConfig | undefined;
  chatbotId?: string | undefined;
  enableRag?: boolean | undefined;
}

export interface AgentsConfig {
  defaultAgentId?: string | undefined;
  defaults?: AgentDefaultsConfig | undefined;
  list?: AgentConfig[] | undefined;
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

function normalizeAgentA2AExposureValue(
  value: unknown,
): AgentA2AExposure | undefined {
  const normalized = normalizeTrimmedString(value).toLowerCase();
  if (
    normalized === 'public' ||
    normalized === 'trusted' ||
    normalized === 'private'
  ) {
    return normalized;
  }
  return undefined;
}

export function normalizeAgentA2AConfig(
  value: unknown,
): AgentA2AConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const exposure = normalizeAgentA2AExposureValue(record.exposure);
  const rawSkillExposure =
    record.skillExposure ?? record.skill_exposure ?? record.skills;
  const skillExposure: Record<string, AgentA2AExposure> = {};
  if (
    rawSkillExposure &&
    typeof rawSkillExposure === 'object' &&
    !Array.isArray(rawSkillExposure)
  ) {
    for (const [rawSkill, rawExposure] of Object.entries(rawSkillExposure)) {
      const skill = normalizeTrimmedString(rawSkill);
      const normalizedExposure = normalizeAgentA2AExposureValue(rawExposure);
      if (skill && normalizedExposure) {
        skillExposure[skill] = normalizedExposure;
      }
    }
  }
  const normalized: AgentA2AConfig = {
    ...(exposure ? { exposure } : {}),
    ...(Object.keys(skillExposure).length > 0 ? { skillExposure } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function cloneAgentA2AConfig(
  value: AgentA2AConfig | undefined,
): AgentA2AConfig | undefined {
  if (!value) return undefined;
  return {
    ...(value.exposure ? { exposure: value.exposure } : {}),
    ...(value.skillExposure
      ? { skillExposure: { ...value.skillExposure } }
      : {}),
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
      const cyclePath = [...path.slice(Math.max(cycleStart, 0)), agentId].join(
        ' -> ',
      );
      throw new Error(`Agent reports_to cycle detected: ${cyclePath}.`);
    }

    visiting.add(agentId);
    path.push(agentId);
    const parentId = reportsToByAgent.get(agentId);
    if (parentId) {
      visit(parentId, path);
    }
    path.pop();
    visiting.delete(agentId);
    visited.add(agentId);
  };

  for (const agentId of reportsToByAgent.keys()) {
    visit(agentId, []);
  }
}
