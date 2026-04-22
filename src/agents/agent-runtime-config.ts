import {
  getRuntimeConfig,
  type RuntimeConfig,
  updateRuntimeConfig,
} from '../config/runtime-config.js';
import type {
  AgentConfig,
  AgentModelConfig,
  AgentsConfig,
} from './agent-types.js';

function sameStringArray(a?: string[], b?: string[]): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((entry, index) => entry === b[index]);
}

function sameModelConfig(a?: AgentModelConfig, b?: AgentModelConfig): boolean {
  if (a === b) return true;
  if (typeof a === 'string' || typeof b === 'string' || !a || !b) return false;
  return a.primary === b.primary && sameStringArray(a.fallbacks, b.fallbacks);
}

function sameAgentConfig(a: AgentConfig | undefined, b: AgentConfig): boolean {
  return (
    Boolean(a) &&
    a?.id === b.id &&
    a.name === b.name &&
    a.displayName === b.displayName &&
    a.imageAsset === b.imageAsset &&
    sameModelConfig(a.model, b.model) &&
    sameStringArray(a.skills, b.skills) &&
    a.workspace === b.workspace &&
    a.chatbotId === b.chatbotId &&
    a.enableRag === b.enableRag
  );
}

function upsertActivatedAgentInList(
  agentsList: AgentConfig[] | undefined,
  agent: AgentConfig,
): { changed: boolean; list: AgentConfig[] } {
  const nextAgents = Array.isArray(agentsList) ? [...agentsList] : [];
  const existingIndex = nextAgents.findIndex(
    (entry) => entry?.id?.trim() === agent.id,
  );
  if (existingIndex >= 0) {
    if (sameAgentConfig(nextAgents[existingIndex], agent)) {
      return { changed: false, list: nextAgents };
    }
    nextAgents[existingIndex] = agent;
    return { changed: true, list: nextAgents };
  }
  nextAgents.push(agent);
  return { changed: true, list: nextAgents };
}

function applyActivatedAgentToRuntimeConfigDraft(
  draft: Pick<RuntimeConfig, 'agents'>,
  agent: AgentConfig,
): boolean {
  draft.agents ??= {};
  const listResult = upsertActivatedAgentInList(draft.agents.list, agent);
  const defaultChanged = draft.agents.defaultAgentId !== agent.id;
  if (!listResult.changed && !defaultChanged) {
    return false;
  }
  draft.agents.list = listResult.list;
  draft.agents.defaultAgentId = agent.id;
  return true;
}

function activatedAgentWouldChange(
  agents: AgentsConfig | undefined,
  agent: AgentConfig,
): boolean {
  const listResult = upsertActivatedAgentInList(agents?.list, agent);
  return listResult.changed || agents?.defaultAgentId !== agent.id;
}

export function activateAgentInRuntimeConfig(agent: AgentConfig): boolean {
  if (!activatedAgentWouldChange(getRuntimeConfig().agents, agent)) {
    return false;
  }
  updateRuntimeConfig((draft) => {
    applyActivatedAgentToRuntimeConfigDraft(draft, agent);
  });
  return true;
}
