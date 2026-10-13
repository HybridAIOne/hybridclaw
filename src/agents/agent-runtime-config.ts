import {
  EXTERNAL_CHANNEL_KINDS,
  type ExternalChannelKind,
} from '../channels/channel.js';
import { isWhatsAppLinked } from '../channels/whatsapp/auth.js';
import { DISCORD_TOKEN } from '../config/config.js';
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
import {
  agentCvEquals,
  agentEscalationTargetEquals,
  agentProxyConfigEquals,
  resolveConfiguredDefaultAgentId,
} from './agent-types.js';

function sameStringArray(a?: string[], b?: string[]): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((entry, index) => entry === b[index]);
}

function sameModelConfig(a?: AgentModelConfig, b?: AgentModelConfig): boolean {
  if (a === b) return true;
  if (typeof a === 'string' || typeof b === 'string' || !a || !b) return false;
  return a.primary === b.primary;
}

function sameAgentConfig(a: AgentConfig | undefined, b: AgentConfig): boolean {
  return (
    Boolean(a) &&
    a?.id === b.id &&
    a.name === b.name &&
    a.displayName === b.displayName &&
    a.imageAsset === b.imageAsset &&
    a.emptyChatHeader === b.emptyChatHeader &&
    sameModelConfig(a.model, b.model) &&
    sameStringArray(a.skills, b.skills) &&
    sameStringArray(a.tools, b.tools) &&
    a.workspace === b.workspace &&
    a.chatbotId === b.chatbotId &&
    a.enableRag === b.enableRag &&
    a.onboarding === b.onboarding &&
    a.owner === b.owner &&
    a.role === b.role &&
    a.reportsTo === b.reportsTo &&
    sameStringArray(a.delegatesTo, b.delegatesTo) &&
    sameStringArray(a.peers, b.peers) &&
    agentCvEquals(a.cv, b.cv) &&
    agentEscalationTargetEquals(a.escalationTarget, b.escalationTarget) &&
    agentProxyConfigEquals(a.proxy, b.proxy)
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

// Discord and WhatsApp have no `enabled` flag: a token or a linked device
// turns them on.
function channelIsOn(draft: RuntimeConfig, kind: ExternalChannelKind): boolean {
  if (kind === 'discord') return Boolean(DISCORD_TOKEN.trim());
  if (kind === 'whatsapp') return isWhatsAppLinked();
  const sections = draft as unknown as Record<string, { enabled?: unknown }>;
  return sections[kind]?.enabled === true;
}

// A new default must not move a running channel: each channel that is on and
// has no binding is bound to the agent it has been answering as.
function bindRunningChannelsToCurrentDefault(draft: RuntimeConfig): void {
  const current = resolveConfiguredDefaultAgentId(draft.agents);
  draft.agents.channels ??= {};
  const channels = draft.agents.channels;
  for (const kind of EXTERNAL_CHANNEL_KINDS) {
    if (!channels[kind] && channelIsOn(draft, kind)) {
      channels[kind] = current;
    }
  }
}

function applyActivatedAgentToRuntimeConfigDraft(
  draft: RuntimeConfig,
  agent: AgentConfig,
): boolean {
  draft.agents ??= {};
  const listResult = upsertActivatedAgentInList(draft.agents.list, agent);
  const defaultChanged = draft.agents.defaultAgentId !== agent.id;
  if (!listResult.changed && !defaultChanged) {
    return false;
  }
  if (defaultChanged) bindRunningChannelsToCurrentDefault(draft);
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
