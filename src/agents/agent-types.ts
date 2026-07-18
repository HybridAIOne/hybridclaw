import { parseAgentIdentity } from '../identity/agent-id.js';
import { parseUserId } from '../identity/user-id.js';
import {
  parseSecretRefInput,
  type SecretRef,
} from '../security/secret-refs.js';
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
    };

export interface AgentCv {
  summary?: string;
  background?: string;
  capabilities?: string[];
  asset?: string;
}

export type AgentA2AExposure = 'public' | 'trusted' | 'private';

export interface AgentA2AConfig {
  exposure?: AgentA2AExposure;
  skillExposure?: Record<string, AgentA2AExposure>;
}

export interface AgentWebSearchConfig {
  searxngBaseUrl?: string;
  searxngBearerTokenRef?: SecretRef;
}

export type AgentProxyConversationScope = 'channel' | 'user';

export interface AgentProxyConfig {
  kind: 'hybridai';
  baseUrl: string;
  chatbotId: string;
  apiKey: SecretRef;
  conversationScope?: AgentProxyConversationScope;
}

export type AgentBudgetCurrency = 'USD' | 'EUR';
export type AgentBudgetUnit = AgentBudgetCurrency | 'tokens';

export interface AgentBudgetConfig {
  cap: number;
  currency: AgentBudgetCurrency;
  unit: AgentBudgetUnit;
}

export interface AgentConfig {
  id: string;
  canonicalId?: string;
  ownerUserId?: string;
  name?: string;
  displayName?: string;
  imageAsset?: string;
  emptyChatHeader?: string;
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
  a2a?: AgentA2AConfig;
  webSearch?: AgentWebSearchConfig;
  proxy?: AgentProxyConfig;
  budget?: AgentBudgetConfig;
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

export function normalizeAgentIdentityFields(params: {
  canonicalId?: string;
  ownerUserId?: string;
  path: string;
}): Pick<AgentConfig, 'canonicalId' | 'ownerUserId'> {
  let canonicalId = '';
  let canonicalUserSlug = '';
  const rawCanonicalId = params.canonicalId?.trim() || '';
  if (rawCanonicalId) {
    try {
      const parsed = parseAgentIdentity(rawCanonicalId);
      canonicalId = parsed.id;
      canonicalUserSlug = parsed.userSlug;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${params.path}.canonicalId is invalid: ${detail}`);
    }
  }

  let ownerUserId = '';
  let ownerUsername = '';
  const rawOwnerUserId = params.ownerUserId?.trim() || '';
  if (rawOwnerUserId) {
    try {
      const parsed = parseUserId(rawOwnerUserId);
      ownerUserId = parsed.id;
      ownerUsername = parsed.username;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${params.path}.ownerUserId is invalid: ${detail}`);
    }
  }

  if (
    canonicalUserSlug &&
    ownerUsername &&
    canonicalUserSlug !== ownerUsername
  ) {
    throw new Error(
      `${params.path}.ownerUserId username must match ${params.path}.canonicalId user slug`,
    );
  }

  return {
    ...(canonicalId ? { canonicalId } : {}),
    ...(ownerUserId ? { ownerUserId } : {}),
  };
}

export function buildOptionalAgentPresentation(
  displayName?: string | null,
  imageAsset?: string | null,
  emptyChatHeader?: string | null,
): Pick<AgentConfig, 'displayName' | 'imageAsset' | 'emptyChatHeader'> {
  return {
    ...(displayName ? { displayName } : {}),
    ...(imageAsset ? { imageAsset } : {}),
    ...(emptyChatHeader ? { emptyChatHeader } : {}),
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

export function cloneAgentWebSearchConfig(
  value: AgentWebSearchConfig | undefined,
): AgentWebSearchConfig | undefined {
  if (!value) return undefined;
  const clone: AgentWebSearchConfig = {
    ...(value.searxngBaseUrl ? { searxngBaseUrl: value.searxngBaseUrl } : {}),
    ...(value.searxngBearerTokenRef
      ? { searxngBearerTokenRef: { ...value.searxngBearerTokenRef } }
      : {}),
  };
  return Object.keys(clone).length > 0 ? clone : undefined;
}

export function cloneAgentProxyConfig(
  value: AgentProxyConfig | undefined,
): AgentProxyConfig | undefined {
  if (!value) return undefined;
  return {
    kind: value.kind,
    baseUrl: value.baseUrl,
    chatbotId: value.chatbotId,
    apiKey: { ...value.apiKey },
    ...(value.conversationScope
      ? { conversationScope: value.conversationScope }
      : {}),
  };
}

export function agentProxyConfigEquals(
  a: AgentProxyConfig | undefined,
  b: AgentProxyConfig | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.kind === b.kind &&
    a.baseUrl === b.baseUrl &&
    a.chatbotId === b.chatbotId &&
    a.apiKey.source === b.apiKey.source &&
    a.apiKey.id === b.apiKey.id &&
    a.conversationScope === b.conversationScope
  );
}

export function cloneAgentBudgetConfig(
  value: AgentBudgetConfig | undefined,
): AgentBudgetConfig | undefined {
  return value ? { ...value, unit: value.unit ?? value.currency } : undefined;
}

function resolveAgentBudgetUnit(params: {
  rawUnit?: string;
  rawCurrency?: string;
  fallback?: AgentBudgetConfig;
}): AgentBudgetUnit {
  if (params.rawUnit === 'tokens') return 'tokens';
  if (params.rawUnit === 'eur') return 'EUR';
  if (params.rawUnit === 'usd') return 'USD';
  if (params.fallback?.unit) return params.fallback.unit;
  if (params.rawCurrency === 'EUR') return 'EUR';
  return 'USD';
}

export function normalizeAgentBudgetConfig(
  value: unknown,
  fallback?: AgentBudgetConfig,
): AgentBudgetConfig | undefined {
  if (value === undefined) return cloneAgentBudgetConfig(fallback);
  if (value === null || value === '') return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return cloneAgentBudgetConfig(fallback);
  }

  const raw = value as Record<string, unknown>;
  const capValue = raw.cap ?? raw.monthlyCap;
  const parsedCap =
    typeof capValue === 'number'
      ? capValue
      : typeof capValue === 'string' && capValue.trim()
        ? Number.parseFloat(capValue)
        : fallback?.cap;
  if (
    typeof parsedCap !== 'number' ||
    !Number.isFinite(parsedCap) ||
    parsedCap <= 0
  ) {
    return undefined;
  }

  const rawCurrency =
    typeof raw.currency === 'string'
      ? raw.currency.trim().toUpperCase()
      : fallback?.currency;
  const rawUnit =
    typeof raw.unit === 'string'
      ? raw.unit.trim().toLowerCase()
      : typeof raw.currency === 'string'
        ? raw.currency.trim().toLowerCase()
        : fallback?.unit?.toLowerCase();
  const unit = resolveAgentBudgetUnit({ rawUnit, rawCurrency, fallback });
  const currency: AgentBudgetCurrency =
    unit === 'EUR' || rawCurrency === 'EUR' ? 'EUR' : 'USD';
  const cap = unit === 'tokens' ? Math.floor(parsedCap) : parsedCap;
  if (!Number.isFinite(cap) || cap <= 0) return undefined;

  return {
    cap,
    currency,
    unit,
  };
}

export function normalizeAgentWebSearchConfig(
  value: unknown,
  path = 'agents.list[].webSearch',
  fallback?: AgentWebSearchConfig,
): AgentWebSearchConfig | undefined {
  if (value === undefined) return cloneAgentWebSearchConfig(fallback);
  if (value === null || value === '') return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return cloneAgentWebSearchConfig(fallback);
  }
  const raw = value as Record<string, unknown>;
  const searxngBaseUrl = Object.hasOwn(raw, 'searxngBaseUrl')
    ? normalizeTrimmedString(raw.searxngBaseUrl)
    : fallback?.searxngBaseUrl;
  let searxngBearerTokenRef: SecretRef | undefined;
  if (
    raw.searxngBearerTokenRef !== undefined &&
    raw.searxngBearerTokenRef !== ''
  ) {
    searxngBearerTokenRef = parseSecretRefInput(
      raw.searxngBearerTokenRef,
      `${path}.searxngBearerTokenRef`,
    );
  } else if (!Object.hasOwn(raw, 'searxngBearerTokenRef')) {
    searxngBearerTokenRef = fallback?.searxngBearerTokenRef
      ? { ...fallback.searxngBearerTokenRef }
      : undefined;
  }
  const normalized: AgentWebSearchConfig = {
    ...(searxngBaseUrl ? { searxngBaseUrl } : {}),
    ...(searxngBearerTokenRef ? { searxngBearerTokenRef } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function parseStoredSecretPlaceholder(
  value: unknown,
  path: string,
): SecretRef | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  const match = normalized.match(/^<secret:([A-Z][A-Z0-9_]{0,127})>$/);
  if (!match?.[1]) return undefined;
  return parseSecretRefInput(
    {
      source: 'store',
      id: match[1],
    },
    path,
  );
}

function parseAgentProxySecretRef(value: unknown, path: string): SecretRef {
  return (
    parseStoredSecretPlaceholder(value, path) ??
    parseSecretRefInput(value, path)
  );
}

function normalizeProxyConversationScope(
  value: unknown,
): AgentProxyConversationScope | undefined {
  const normalized = normalizeTrimmedString(value).toLowerCase();
  if (normalized === 'channel' || normalized === 'user') return normalized;
  return undefined;
}

export function normalizeAgentProxyConfig(
  value: unknown,
  path = 'agents.list[].proxy',
): AgentProxyConfig | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object or null.`);
  }

  const raw = value as Record<string, unknown>;
  const kind = normalizeTrimmedString(raw.kind).toLowerCase();
  if (kind !== 'hybridai') {
    throw new Error(`${path}.kind must be "hybridai".`);
  }

  const baseUrl = normalizeTrimmedString(raw.baseUrl ?? raw.base_url);
  if (!baseUrl) {
    throw new Error(`${path}.baseUrl is required for HybridAI proxy agents.`);
  }
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch {
    throw new Error(`${path}.baseUrl must be a valid HTTPS URL.`);
  }
  if (parsedBaseUrl.protocol !== 'https:') {
    throw new Error(`${path}.baseUrl must use HTTPS.`);
  }
  parsedBaseUrl.pathname = parsedBaseUrl.pathname.replace(/\/+$/g, '');
  parsedBaseUrl.username = '';
  parsedBaseUrl.password = '';
  parsedBaseUrl.search = '';
  parsedBaseUrl.hash = '';

  const chatbotId = normalizeTrimmedString(raw.chatbotId ?? raw.chatbot_id);
  if (!chatbotId) {
    throw new Error(`${path}.chatbotId is required for HybridAI proxy agents.`);
  }

  const apiKeyInput =
    raw.apiKey ?? raw.api_key ?? raw.apiKeyRef ?? raw.api_key_ref;
  const apiKey = parseAgentProxySecretRef(apiKeyInput, `${path}.apiKey`);
  const conversationScope = normalizeProxyConversationScope(
    raw.conversationScope ?? raw.conversation_scope,
  );

  return {
    kind: 'hybridai',
    baseUrl: parsedBaseUrl.toString().replace(/\/+$/g, ''),
    chatbotId,
    apiKey,
    ...(conversationScope ? { conversationScope } : {}),
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
