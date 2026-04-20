import fs from 'node:fs';
import path from 'node:path';

import {
  DATA_DIR,
  HYBRIDAI_CHATBOT_ID,
  HYBRIDAI_MODEL,
} from '../config/config.js';
import { getRuntimeConfig } from '../config/runtime-config.js';
import { logger } from '../logger.js';
import {
  deleteAgent as dbDeleteAgent,
  getAgentById as dbGetAgentById,
  listAgents as dbListAgents,
  upsertAgent as dbUpsertAgent,
  isDatabaseInitialized,
} from '../memory/db.js';
import type { Session } from '../types/session.js';
import {
  normalizeNullableTrimmedString as normalizeNullableString,
  normalizeOptionalTrimmedUniqueStringArray,
  normalizeTrimmedString as normalizeString,
} from '../utils/normalized-strings.js';
import {
  type AgentConfig,
  type AgentDefaultsConfig,
  type AgentModelConfig,
  type AgentsConfig,
  buildOptionalAgentPresentation,
  DEFAULT_AGENT_ID,
} from './agent-types.js';

const LEGACY_WORKSPACE_DIRS = [
  'default',
  'ollama',
  'vllm',
  'lmstudio',
  'llamacpp',
  'anthropic',
  'openai-codex',
] as const;

let configuredDefaults: AgentDefaultsConfig;
let configuredDefaultAgentId: string;
let configuredAgents: AgentConfig[];
let registry: Map<string, AgentConfig>;
let registryInitialized: boolean;
let registryDbBacked: boolean;
let lastConfigFingerprint: string;

function resetRegistryState(): void {
  configuredDefaults = {};
  configuredDefaultAgentId = DEFAULT_AGENT_ID;
  configuredAgents = [{ id: DEFAULT_AGENT_ID }];
  registry = new Map<string, AgentConfig>([
    [DEFAULT_AGENT_ID, { id: DEFAULT_AGENT_ID, name: 'Main Agent' }],
  ]);
  registryInitialized = false;
  registryDbBacked = false;
  lastConfigFingerprint = '';
}

resetRegistryState();

function cloneModelConfig(
  value: AgentModelConfig | undefined,
): AgentModelConfig | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') return value;
  return {
    primary: value.primary,
    ...(Array.isArray(value.fallbacks) && value.fallbacks.length > 0
      ? { fallbacks: [...value.fallbacks] }
      : {}),
  };
}

function normalizeModelConfig(value: unknown): AgentModelConfig | undefined {
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized || undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const primary = normalizeString((value as { primary?: unknown }).primary);
  if (!primary) return undefined;
  const rawFallbacks: unknown[] = Array.isArray(
    (value as { fallbacks?: unknown }).fallbacks,
  )
    ? ((value as { fallbacks?: unknown[] }).fallbacks ?? [])
    : [];
  const seen = new Set<string>([primary]);
  const fallbacks = rawFallbacks
    .map((entry) => normalizeString(entry))
    .filter((entry) => {
      if (!entry || seen.has(entry)) return false;
      seen.add(entry);
      return true;
    });
  return fallbacks.length > 0 ? { primary, fallbacks } : { primary };
}

function normalizeDefaults(value: unknown): AgentDefaultsConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const model = normalizeModelConfig((value as { model?: unknown }).model);
  const chatbotId = normalizeString(
    (value as { chatbotId?: unknown }).chatbotId,
  );
  const enableRag =
    typeof (value as { enableRag?: unknown }).enableRag === 'boolean'
      ? (value as { enableRag: boolean }).enableRag
      : undefined;
  return {
    ...(model ? { model } : {}),
    ...(chatbotId ? { chatbotId } : {}),
    ...(typeof enableRag === 'boolean' ? { enableRag } : {}),
  };
}

function normalizeDefaultAgentId(
  value: unknown,
  agentIds: ReadonlySet<string>,
): string {
  const normalized = normalizeString(value);
  if (normalized && agentIds.has(normalized)) {
    return normalized;
  }
  return DEFAULT_AGENT_ID;
}

function normalizeAgent(value: unknown): AgentConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = normalizeString((value as { id?: unknown }).id);
  if (!id) return null;
  const name = normalizeString((value as { name?: unknown }).name);
  const displayName = normalizeString(
    (value as { displayName?: unknown }).displayName,
  );
  const imageAsset = normalizeString(
    (value as { imageAsset?: unknown }).imageAsset,
  );
  const model = normalizeModelConfig((value as { model?: unknown }).model);
  const workspace = normalizeString(
    (value as { workspace?: unknown }).workspace,
  );
  const chatbotId = normalizeString(
    (value as { chatbotId?: unknown }).chatbotId,
  );
  const enableRag =
    typeof (value as { enableRag?: unknown }).enableRag === 'boolean'
      ? (value as { enableRag: boolean }).enableRag
      : undefined;
  const skills = normalizeOptionalTrimmedUniqueStringArray(
    (value as { skills?: unknown }).skills,
  );
  return {
    id,
    ...(name ? { name } : {}),
    ...buildOptionalAgentPresentation(displayName, imageAsset),
    ...(model ? { model } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(workspace ? { workspace } : {}),
    ...(chatbotId ? { chatbotId } : {}),
    ...(typeof enableRag === 'boolean' ? { enableRag } : {}),
  };
}

function normalizeAgentsConfig(config: AgentsConfig | undefined): {
  defaultAgentId: string;
  defaults: AgentDefaultsConfig;
  list: AgentConfig[];
  fingerprint: string;
} {
  const defaults = normalizeDefaults(config?.defaults);
  const seen = new Set<string>();
  const list: AgentConfig[] = [];
  for (const entry of Array.isArray(config?.list) ? config.list : []) {
    const normalized = normalizeAgent(entry);
    if (!normalized || seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    list.push(normalized);
  }
  if (!seen.has(DEFAULT_AGENT_ID)) {
    list.unshift({ id: DEFAULT_AGENT_ID, name: 'Main Agent' });
    seen.add(DEFAULT_AGENT_ID);
  }
  const defaultAgentId = normalizeDefaultAgentId(config?.defaultAgentId, seen);
  return {
    defaultAgentId,
    defaults,
    list,
    fingerprint: JSON.stringify({
      defaultAgentId,
      defaults,
      list,
    }),
  };
}

function applyDefaults(agent: AgentConfig): AgentConfig {
  const model = cloneModelConfig(agent.model ?? configuredDefaults.model);
  const skills = agent.skills ? [...agent.skills] : undefined;
  const chatbotId = normalizeString(
    agent.chatbotId ?? configuredDefaults.chatbotId,
  );
  const enableRag = agent.enableRag ?? configuredDefaults.enableRag;
  return {
    id: agent.id,
    ...(agent.name ? { name: agent.name } : {}),
    ...buildOptionalAgentPresentation(agent.displayName, agent.imageAsset),
    ...(model ? { model } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(agent.workspace ? { workspace: agent.workspace } : {}),
    ...(chatbotId ? { chatbotId } : {}),
    ...(typeof enableRag === 'boolean' ? { enableRag } : {}),
  };
}

function rebuildFallbackRegistry(): void {
  registry = new Map<string, AgentConfig>();
  for (const agent of configuredAgents) {
    registry.set(agent.id, agent);
  }
  if (!registry.has(DEFAULT_AGENT_ID)) {
    registry.set(DEFAULT_AGENT_ID, {
      id: DEFAULT_AGENT_ID,
      name: 'Main Agent',
    });
  }
}

function rebuildRegistryFromDatabase(): void {
  registry = new Map<string, AgentConfig>();
  for (const agent of dbListAgents()) {
    registry.set(agent.id, agent);
  }
  if (!registry.has(DEFAULT_AGENT_ID)) {
    registry.set(DEFAULT_AGENT_ID, {
      id: DEFAULT_AGENT_ID,
      name: 'Main Agent',
    });
  }
}

function syncConfiguredAgentsToDatabase(): void {
  const mainAgent = configuredAgents.find(
    (entry) => entry.id === DEFAULT_AGENT_ID,
  ) ?? {
    id: DEFAULT_AGENT_ID,
    name: 'Main Agent',
  };
  dbUpsertAgent({
    id: DEFAULT_AGENT_ID,
    name: mainAgent.name || 'Main Agent',
    displayName: mainAgent.displayName,
    imageAsset: mainAgent.imageAsset,
    model: cloneModelConfig(mainAgent.model),
    skills: mainAgent.skills,
    workspace: mainAgent.workspace,
    chatbotId: mainAgent.chatbotId,
    enableRag: mainAgent.enableRag,
  });

  for (const agent of configuredAgents) {
    dbUpsertAgent({
      id: agent.id,
      name: agent.name,
      displayName: agent.displayName,
      imageAsset: agent.imageAsset,
      model: cloneModelConfig(agent.model),
      skills: agent.skills,
      workspace: agent.workspace,
      chatbotId: agent.chatbotId,
      enableRag: agent.enableRag,
    });
  }
}

function safeWorkspaceName(rawName: string): string {
  // This only makes the workspace segment filesystem-safe; it does not
  // preserve uniqueness. Values like `foo-bar` and `foo_bar` normalize to the
  // same directory, so agent ids / workspace overrides should remain stable
  // and intentionally unique at the config layer.
  return rawName.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function agentRootDirByWorkspaceName(workspaceName: string): string {
  return path.join(DATA_DIR, 'agents', safeWorkspaceName(workspaceName));
}

function agentWorkspaceDirByWorkspaceName(workspaceName: string): string {
  return path.join(agentRootDirByWorkspaceName(workspaceName), 'workspace');
}

function ensureRegistryCurrent(): void {
  const normalized = normalizeAgentsConfig(getRuntimeConfig().agents);
  const shouldReload =
    !registryInitialized ||
    normalized.fingerprint !== lastConfigFingerprint ||
    (!registryDbBacked && isDatabaseInitialized());
  if (!shouldReload) return;
  initAgentRegistry({
    defaultAgentId: normalized.defaultAgentId,
    defaults: normalized.defaults,
    list: normalized.list,
  });
}

export function initAgentRegistry(config: AgentsConfig): void {
  const normalized = normalizeAgentsConfig(config);
  configuredDefaultAgentId = normalized.defaultAgentId;
  configuredDefaults = normalized.defaults;
  configuredAgents = normalized.list;
  lastConfigFingerprint = normalized.fingerprint;

  if (!isDatabaseInitialized()) {
    rebuildFallbackRegistry();
    registryInitialized = true;
    registryDbBacked = false;
    return;
  }

  syncConfiguredAgentsToDatabase();
  rebuildRegistryFromDatabase();
  registryInitialized = true;
  registryDbBacked = true;
  migrateWorkspaceDirs();
}

export function findAgentConfig(agentId?: string | null): AgentConfig | null {
  ensureRegistryCurrent();
  const normalizedId = normalizeString(agentId) || DEFAULT_AGENT_ID;
  const agent = registry.get(normalizedId);
  return agent ? applyDefaults(agent) : null;
}

export function resolveAgentConfig(agentId?: string | null): AgentConfig {
  const normalizedId = normalizeString(agentId) || DEFAULT_AGENT_ID;
  return (
    findAgentConfig(normalizedId) ??
    applyDefaults({
      id: normalizedId,
      ...(normalizedId === DEFAULT_AGENT_ID ? { name: 'Main Agent' } : {}),
    })
  );
}

export function resolveAgentModel(
  agent: AgentConfig | null | undefined,
): string | undefined {
  if (!agent?.model) return undefined;
  if (typeof agent.model === 'string') return normalizeString(agent.model);
  return normalizeString(agent.model.primary) || undefined;
}

export function resolveAgentModelFallbacks(
  agent: AgentConfig | null | undefined,
  activeModel?: string | null,
): string[] {
  if (!agent?.model || typeof agent.model === 'string') return [];
  const modelConfig = agent.model as Exclude<
    AgentModelConfig,
    string | undefined
  >;
  const primary = normalizeString(modelConfig.primary);
  if (!primary) return [];
  const normalizedActiveModel = normalizeString(activeModel);
  if (normalizedActiveModel && normalizedActiveModel !== primary) {
    return [];
  }
  const fallbacks = Array.isArray(modelConfig.fallbacks)
    ? modelConfig.fallbacks
    : [];
  return (normalizeOptionalTrimmedUniqueStringArray(fallbacks) || []).filter(
    (candidate) => candidate !== primary,
  );
}

export function resolveAgentWorkspaceId(agentId?: string | null): string {
  const agent = resolveAgentConfig(agentId);
  return normalizeString(agent.workspace) || agent.id;
}

export function resolveAgentForRequest(params?: {
  agentId?: string | null;
  session?: Session | null;
  model?: string | null;
  chatbotId?: string | null;
}): {
  agentId: string;
  model: string;
  chatbotId: string;
} {
  ensureRegistryCurrent();
  const requestedAgentId = normalizeString(params?.agentId);
  const sessionAgentId = normalizeString(params?.session?.agent_id);
  const agentId =
    requestedAgentId ||
    sessionAgentId ||
    configuredDefaultAgentId ||
    DEFAULT_AGENT_ID;
  const agent = resolveAgentConfig(agentId);
  const requestedModel =
    params?.model == null ? '' : normalizeString(params.model);
  const sessionModel = normalizeString(params?.session?.model);
  const model =
    requestedModel ||
    sessionModel ||
    resolveAgentModel(agent) ||
    HYBRIDAI_MODEL;
  const requestedChatbotId =
    params?.chatbotId == null ? null : normalizeString(params.chatbotId);
  const sessionChatbotId = normalizeNullableString(params?.session?.chatbot_id);
  const agentChatbotId = normalizeNullableString(agent.chatbotId);
  const defaultChatbotId = normalizeNullableString(HYBRIDAI_CHATBOT_ID);
  const chatbotId =
    requestedChatbotId ??
    sessionChatbotId ??
    agentChatbotId ??
    defaultChatbotId ??
    '';
  return { agentId, model, chatbotId };
}

export function listAgents(): AgentConfig[] {
  ensureRegistryCurrent();
  return Array.from(registry.values())
    .map((agent) => applyDefaults(agent))
    .sort((left, right) => {
      if (left.id === DEFAULT_AGENT_ID && right.id !== DEFAULT_AGENT_ID) {
        return -1;
      }
      if (right.id === DEFAULT_AGENT_ID && left.id !== DEFAULT_AGENT_ID) {
        return 1;
      }
      return left.id.localeCompare(right.id);
    });
}

export function getAgentById(agentId: string): AgentConfig | null {
  const normalizedId = normalizeString(agentId);
  if (!normalizedId) return null;
  ensureRegistryCurrent();
  if (isDatabaseInitialized()) {
    const stored = dbGetAgentById(normalizedId);
    return stored ? applyDefaults(stored) : null;
  }
  return findAgentConfig(normalizedId);
}

export function getStoredAgentConfig(
  agentId?: string | null,
): AgentConfig | null {
  const normalizedId = normalizeString(agentId) || DEFAULT_AGENT_ID;
  ensureRegistryCurrent();
  if (isDatabaseInitialized()) {
    return dbGetAgentById(normalizedId);
  }
  return registry.get(normalizedId) || null;
}

export function upsertRegisteredAgent(agent: AgentConfig): AgentConfig {
  if (!isDatabaseInitialized()) {
    throw new Error('Database is not initialized.');
  }
  const normalized = normalizeAgent(agent);
  if (!normalized) {
    throw new Error('Agent id is required.');
  }
  dbUpsertAgent(normalized);
  rebuildRegistryFromDatabase();
  registryInitialized = true;
  registryDbBacked = true;
  return resolveAgentConfig(normalized.id);
}

export function deleteRegisteredAgent(agentId: string): boolean {
  const normalizedId = normalizeString(agentId);
  if (!normalizedId) return false;
  if (!isDatabaseInitialized()) {
    throw new Error('Database is not initialized.');
  }
  const deleted = dbDeleteAgent(normalizedId);
  rebuildRegistryFromDatabase();
  registryInitialized = true;
  registryDbBacked = true;
  return deleted;
}

export function migrateWorkspaceDirs(): void {
  const mainWorkspaceName = resolveAgentWorkspaceId(DEFAULT_AGENT_ID);
  const targetRoot = agentRootDirByWorkspaceName(mainWorkspaceName);
  const targetWorkspace = agentWorkspaceDirByWorkspaceName(mainWorkspaceName);
  if (fs.existsSync(targetWorkspace)) return;

  const legacyMatches = LEGACY_WORKSPACE_DIRS.filter((legacyName) =>
    fs.existsSync(agentWorkspaceDirByWorkspaceName(legacyName)),
  );
  if (legacyMatches.length === 0) return;

  const primaryMatch = legacyMatches[0];
  const primarySourceRoot = agentRootDirByWorkspaceName(primaryMatch);
  try {
    fs.mkdirSync(path.dirname(targetRoot), { recursive: true });
    if (!fs.existsSync(targetRoot)) {
      fs.renameSync(primarySourceRoot, targetRoot);
    } else {
      const sourceWorkspace = agentWorkspaceDirByWorkspaceName(primaryMatch);
      if (fs.existsSync(sourceWorkspace) && !fs.existsSync(targetWorkspace)) {
        fs.renameSync(sourceWorkspace, targetWorkspace);
      }
    }
    logger.info(
      {
        from: primarySourceRoot,
        to: targetRoot,
      },
      'Migrated legacy agent workspace to main agent',
    );
  } catch (error) {
    logger.warn(
      {
        error,
        from: primarySourceRoot,
        to: targetRoot,
      },
      'Failed to migrate legacy agent workspace',
    );
    return;
  }

  if (legacyMatches.length > 1) {
    logger.warn(
      {
        orphanedLegacyWorkspaceDirs: legacyMatches
          .slice(1)
          .map((legacyName) => agentRootDirByWorkspaceName(legacyName)),
      },
      'Additional legacy agent workspaces remain on disk after migration',
    );
  }
}

// Tree-shakeable test helper for suites that intentionally reuse a module instance.
export function resetAgentRegistryForTesting(): void {
  resetRegistryState();
}
