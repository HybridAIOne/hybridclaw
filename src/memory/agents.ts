import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type {
  AgentConfig,
  AgentCv,
  AgentModelConfig,
} from '../agents/agent-types.js';
import {
  DEFAULT_AGENT_ID,
  normalizeAgentA2AConfig,
  normalizeAgentCv,
  normalizeAgentEscalationTarget,
  normalizeAgentIdentityFields,
  normalizeAgentProxyConfig,
  validateAgentOrgChart,
} from '../agents/agent-types.js';
import {
  type AgentTeamStructureEntry,
  serializeAgentTeamStructure,
} from '../agents/team-structure.js';
import { agentTeamStructureAssetPath } from '../agents/team-structure-revisions.js';
import {
  type RuntimeConfigChangeMeta,
  runtimeConfigRevisionStorePath,
  syncRuntimeAssetRevisionStateInOpenDatabase,
} from '../config/runtime-config-revisions.js';
import {
  AGENT_IDENTITY_COMPONENT_MAX_LENGTH,
  deriveLocalAgentIdentity,
  formatAgentIdentity,
  formatLocalOwnerUserId,
  parseAgentIdentity,
} from '../identity/agent-id.js';
import { parseUserId } from '../identity/user-id.js';
import { logger } from '../logger.js';
import { normalizeTrimmedUniqueStringArray } from '../utils/normalized-strings.js';
import { withMemoryDatabase } from './database.js';
import { columnExists, tableExists } from './schema/migrations.js';
import { queryAll, queryOne } from './sqlite.js';

const AGENT_CANONICAL_ID_COLLISION_LIMIT = 20;
const DEFAULT_LOCAL_OWNER_USER_ID = formatLocalOwnerUserId('');
const RUNTIME_REVISION_ATTACHMENT = 'runtime_revisions';

type AgentRow = {
  id: AgentConfig['id'];
  archived: number;
  canonical_id: string | null;
  owner_user_id: string | null;
  name: string | null;
  display_name: string | null;
  image_asset: string | null;
  empty_chat_header: string | null;
  model: string | null;
  skills: string | null;
  chatbot_id: string | null;
  enable_rag: number | null;
  workspace: string | null;
  owner: string | null;
  role: string | null;
  reports_to: string | null;
  delegates_to: string | null;
  peers: string | null;
  cv: string | null;
  escalation_target: string | null;
  a2a: string | null;
  proxy: string | null;
  created_at: string;
  updated_at: string;
};

function getAgentDatabase(): Database.Database {
  return withMemoryDatabase((database) => database);
}

function withRuntimeRevisionDatabaseAttached<T>(fn: () => T): T {
  const revisionDbPath = runtimeConfigRevisionStorePath();
  fs.mkdirSync(path.dirname(revisionDbPath), { recursive: true });
  getAgentDatabase()
    .prepare(`ATTACH DATABASE ? AS ${RUNTIME_REVISION_ATTACHMENT}`)
    .run(revisionDbPath);
  try {
    return fn();
  } finally {
    getAgentDatabase().exec(`DETACH DATABASE ${RUNTIME_REVISION_ATTACHMENT}`);
  }
}

function serializeAgentModelConfig(
  model: AgentModelConfig | undefined,
): string | null {
  if (!model) return null;
  if (typeof model === 'string') {
    const normalized = model.trim();
    return normalized || null;
  }
  const primary = model.primary.trim();
  if (!primary) return null;
  return JSON.stringify({ primary });
}

function parseAgentModelConfig(
  rawModel: string | null,
): AgentModelConfig | undefined {
  const normalized = rawModel?.trim() || '';
  if (!normalized) return undefined;

  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (typeof parsed === 'string') {
      const value = parsed.trim();
      return value || undefined;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const primary =
        typeof (parsed as { primary?: unknown }).primary === 'string'
          ? (parsed as { primary: string }).primary.trim()
          : '';
      if (!primary) return undefined;
      return { primary };
    }
  } catch {
    // Keep supporting legacy plain-string rows stored before JSON objects.
  }

  return normalized;
}

function parseAgentSkillsConfig(
  rawSkills: string | null,
): string[] | undefined {
  const normalized = rawSkills?.trim() || '';
  if (!normalized) return undefined;

  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (!Array.isArray(parsed)) return undefined;

    return normalizeTrimmedUniqueStringArray(parsed);
  } catch {
    logger.warn(
      { rawSkills: normalized },
      'Failed to parse persisted agent skills configuration',
    );
    return undefined;
  }
}

function serializeAgentSkillsConfig(skills?: string[]): string | null {
  if (!Array.isArray(skills)) return null;
  return JSON.stringify(normalizeTrimmedUniqueStringArray(skills));
}

function serializeAgentCv(cv: AgentCv | undefined): string | null {
  return cv ? JSON.stringify(cv) : null;
}

function serializeAgentStringArray(
  values: string[] | undefined,
): string | null {
  if (!Array.isArray(values)) return null;
  return JSON.stringify(normalizeTrimmedUniqueStringArray(values));
}

function syncAttachedTeamRevisionState(
  agents: AgentConfig[],
  meta: RuntimeConfigChangeMeta,
): void {
  syncRuntimeAssetRevisionStateInOpenDatabase(
    getAgentDatabase(),
    'team',
    agentTeamStructureAssetPath(),
    meta,
    {
      exists: true,
      content: serializeAgentTeamStructure(agents, { validate: false }),
    },
    new Date().toISOString(),
    {
      schemaName: RUNTIME_REVISION_ATTACHMENT,
    },
  );
}

function parseAgentStringArray(
  rawValues: string | null,
  fieldName: string,
): string[] | undefined {
  const normalized = rawValues?.trim() || '';
  if (!normalized) return undefined;

  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    return normalizeTrimmedUniqueStringArray(parsed);
  } catch {
    logger.warn(
      { fieldName, payloadLength: normalized.length },
      'Failed to parse persisted agent org-chart relationship list',
    );
    return undefined;
  }
}

function parseAgentCv(rawCv: string | null): AgentCv | undefined {
  const normalized = rawCv?.trim() || '';
  if (!normalized) return undefined;

  try {
    return normalizeAgentCv(JSON.parse(normalized));
  } catch {
    logger.warn(
      { cvLength: normalized.length },
      'Failed to parse persisted agent CV configuration',
    );
    return undefined;
  }
}

function serializeAgentEscalationTarget(
  target: AgentConfig['escalationTarget'],
): string | null {
  return target ? JSON.stringify(target) : null;
}

function parseAgentEscalationTarget(
  rawTarget: string | null,
): AgentConfig['escalationTarget'] {
  const normalized = rawTarget?.trim() || '';
  if (!normalized) return undefined;

  try {
    return normalizeAgentEscalationTarget(JSON.parse(normalized));
  } catch {
    logger.warn(
      { targetLength: normalized.length },
      'Failed to parse persisted agent escalation target',
    );
    return undefined;
  }
}

function serializeAgentA2AConfig(a2a: AgentConfig['a2a']): string | null {
  return a2a ? JSON.stringify(a2a) : null;
}

function parseAgentA2AConfig(rawConfig: string | null): AgentConfig['a2a'] {
  const normalized = rawConfig?.trim() || '';
  if (!normalized) return undefined;

  try {
    return normalizeAgentA2AConfig(JSON.parse(normalized));
  } catch {
    logger.warn(
      { configLength: normalized.length },
      'Failed to parse persisted agent A2A configuration',
    );
    return undefined;
  }
}

function serializeAgentProxyConfig(proxy: AgentConfig['proxy']): string | null {
  return proxy ? JSON.stringify(proxy) : null;
}

function parseAgentProxyConfig(rawConfig: string | null): AgentConfig['proxy'] {
  const normalized = rawConfig?.trim() || '';
  if (!normalized) return undefined;

  try {
    return normalizeAgentProxyConfig(JSON.parse(normalized), 'agents.proxy');
  } catch {
    logger.warn(
      { configLength: normalized.length },
      'Failed to parse persisted agent proxy configuration',
    );
    return undefined;
  }
}

function normalizeStoredIdentityField(
  value: string | null,
  parseIdentity: (normalized: string) => { id: string },
  params: {
    agentId: string;
    lengthKey: string;
    warning: string;
  },
): string {
  const normalized = value?.trim() || '';
  if (!normalized) return '';
  try {
    return parseIdentity(normalized).id;
  } catch {
    logger.warn(
      { agentId: params.agentId, [params.lengthKey]: normalized.length },
      params.warning,
    );
    return '';
  }
}

function normalizeStoredCanonicalAgentId(
  value: string | null,
  agentId: string,
): string {
  return normalizeStoredIdentityField(value, parseAgentIdentity, {
    agentId,
    lengthKey: 'canonicalIdLength',
    warning: 'Ignoring invalid persisted canonical agent identity',
  });
}

function normalizeStoredOwnerUserId(
  value: string | null,
  agentId: string,
): string {
  return normalizeStoredIdentityField(value, parseUserId, {
    agentId,
    lengthKey: 'ownerUserIdLength',
    warning: 'Ignoring invalid persisted agent owner user id',
  });
}

function prepareCanonicalAgentIdentityConflictStatement(
  database: Database.Database,
): Database.Statement | null {
  if (!tableExists(database, 'agents')) return null;
  if (!columnExists(database, 'agents', 'canonical_id')) return null;
  return database.prepare(
    `SELECT id
     FROM agents
     WHERE canonical_id = ? AND id != ?
     LIMIT 1`,
  );
}

function canonicalAgentIdentityExists(
  statement: Database.Statement,
  canonicalId: string,
  agentId: string,
): boolean {
  const row = statement.get(canonicalId, agentId) as { id: string } | undefined;
  return Boolean(row);
}

function addCollisionSuffixToAgentSlug(slug: string, index: number): string {
  const suffix = `-${index}`;
  return `${slug.slice(0, AGENT_IDENTITY_COMPONENT_MAX_LENGTH - suffix.length)}${suffix}`;
}

function ownerUserIdMatchesCanonicalAgentId(
  canonicalId: string,
  ownerUserId: string | undefined,
): boolean {
  if (!ownerUserId) return false;
  try {
    normalizeAgentIdentityFields({
      canonicalId,
      ownerUserId,
      path: 'agents',
    });
    return true;
  } catch {
    return false;
  }
}

function isDefaultPlaceholderIdentity(
  agent: AgentConfig | null | undefined,
): boolean {
  return (
    Boolean(agent) &&
    !agent?.owner &&
    agent?.ownerUserId === DEFAULT_LOCAL_OWNER_USER_ID
  );
}

function allocateCanonicalAgentIdentity(params: {
  database: Database.Database;
  conflictStatement?: Database.Statement | null;
  agentId: string;
  owner?: string | null;
  ownerUserId?: string | null;
}): { canonicalId: string; ownerUserId: string } {
  const identity = deriveLocalAgentIdentity({
    agentId: params.agentId,
    owner: params.owner ?? undefined,
    ownerUserId: params.ownerUserId ?? undefined,
  });
  const conflictStatement =
    params.conflictStatement ??
    prepareCanonicalAgentIdentityConflictStatement(params.database);
  if (!conflictStatement) return identity;
  if (
    !canonicalAgentIdentityExists(
      conflictStatement,
      identity.canonicalId,
      params.agentId,
    )
  ) {
    return identity;
  }

  const parsed = parseAgentIdentity(identity.canonicalId);
  for (let index = 2; index <= AGENT_CANONICAL_ID_COLLISION_LIMIT; index += 1) {
    const canonicalId = formatAgentIdentity(
      addCollisionSuffixToAgentSlug(parsed.agentSlug, index),
      parsed.userSlug,
      parsed.instanceId,
    );
    if (
      !canonicalAgentIdentityExists(
        conflictStatement,
        canonicalId,
        params.agentId,
      )
    ) {
      return {
        canonicalId,
        ownerUserId: identity.ownerUserId,
      };
    }
  }

  throw new Error(
    `Could not allocate a unique canonical agent identity for ${params.agentId}.`,
  );
}

function mapAgentRow(row: AgentRow): AgentConfig {
  const canonicalId = normalizeStoredCanonicalAgentId(row.canonical_id, row.id);
  const ownerUserId = normalizeStoredOwnerUserId(row.owner_user_id, row.id);
  const name = row.name?.trim() || '';
  const displayName = row.display_name?.trim() || '';
  const imageAsset = row.image_asset?.trim() || '';
  const emptyChatHeader = row.empty_chat_header?.trim() || '';
  const model = parseAgentModelConfig(row.model);
  const skills = parseAgentSkillsConfig(row.skills);
  const chatbotId = row.chatbot_id?.trim() || '';
  const workspace = row.workspace?.trim() || '';
  const owner = row.owner?.trim() || '';
  const role = row.role?.trim() || '';
  const reportsTo = row.reports_to?.trim() || '';
  const delegatesTo = parseAgentStringArray(row.delegates_to, 'delegates_to');
  const peers = parseAgentStringArray(row.peers, 'peers');
  const cv = parseAgentCv(row.cv);
  const escalationTarget = parseAgentEscalationTarget(row.escalation_target);
  const a2a = parseAgentA2AConfig(row.a2a);
  const proxy = parseAgentProxyConfig(row.proxy);
  return {
    id: row.id,
    archived: row.archived !== 0,
    ...(canonicalId ? { canonicalId } : {}),
    ...(ownerUserId ? { ownerUserId } : {}),
    ...(name ? { name } : {}),
    ...(displayName ? { displayName } : {}),
    ...(imageAsset ? { imageAsset } : {}),
    ...(emptyChatHeader ? { emptyChatHeader } : {}),
    ...(model ? { model } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(chatbotId ? { chatbotId } : {}),
    ...(workspace ? { workspace } : {}),
    ...(typeof row.enable_rag === 'number'
      ? { enableRag: row.enable_rag !== 0 }
      : {}),
    ...(owner ? { owner } : {}),
    ...(role ? { role } : {}),
    ...(reportsTo ? { reportsTo } : {}),
    ...(delegatesTo !== undefined ? { delegatesTo } : {}),
    ...(peers !== undefined ? { peers } : {}),
    ...(cv ? { cv } : {}),
    ...(escalationTarget ? { escalationTarget } : {}),
    ...(a2a ? { a2a } : {}),
    ...(proxy ? { proxy } : {}),
  };
}

const AGENT_SELECT_COLUMNS =
  'id, archived, canonical_id, owner_user_id, name, display_name, image_asset, empty_chat_header, model, skills, chatbot_id, enable_rag, workspace, owner, role, reports_to, delegates_to, peers, cv, escalation_target, a2a, proxy, created_at, updated_at';

export function getAgentById(agentId: string): AgentConfig | null {
  const normalizedAgentId = agentId.trim();
  if (!normalizedAgentId) return null;
  const row = queryOne<AgentRow, [string]>(
    getAgentDatabase(),
    `SELECT ${AGENT_SELECT_COLUMNS}
     FROM agents
     WHERE id = ?`,
    normalizedAgentId,
  );
  return row ? mapAgentRow(row) : null;
}

export function listAgents(): AgentConfig[] {
  const rows = queryAll<AgentRow, [string]>(
    getAgentDatabase(),
    `SELECT ${AGENT_SELECT_COLUMNS}
     FROM agents
     ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, id ASC`,
    DEFAULT_AGENT_ID,
  );
  return rows.map(mapAgentRow);
}

export function upsertAgent(agent: AgentConfig): AgentConfig {
  const normalizedId = agent.id.trim();
  if (!normalizedId) {
    throw new Error('Agent id is required.');
  }
  const existingAgent = getAgentById(normalizedId);
  const archived =
    typeof agent.archived === 'boolean'
      ? agent.archived
        ? 1
        : 0
      : existingAgent?.archived
        ? 1
        : 0;
  const normalizedName = agent.name?.trim() || null;
  const normalizedDisplayName = agent.displayName?.trim() || null;
  const normalizedImageAsset = agent.imageAsset?.trim() || null;
  const normalizedEmptyChatHeader = agent.emptyChatHeader?.trim() || null;
  const normalizedModel = serializeAgentModelConfig(agent.model);
  const normalizedSkills = serializeAgentSkillsConfig(agent.skills);
  const normalizedChatbotId = agent.chatbotId?.trim() || null;
  const normalizedWorkspace = agent.workspace?.trim() || null;
  const normalizedOwner = agent.owner?.trim() || null;
  const normalizedRole = agent.role?.trim() || null;
  const normalizedReportsTo = agent.reportsTo?.trim() || null;
  const normalizedDelegatesTo = serializeAgentStringArray(agent.delegatesTo);
  const normalizedPeers = serializeAgentStringArray(agent.peers);
  const normalizedCv = serializeAgentCv(agent.cv);
  const normalizedEscalationTarget = serializeAgentEscalationTarget(
    agent.escalationTarget,
  );
  const normalizedA2A = serializeAgentA2AConfig(agent.a2a);
  const normalizedProxy = serializeAgentProxyConfig(agent.proxy);
  const explicitIdentity = normalizeAgentIdentityFields({
    canonicalId: agent.canonicalId,
    ownerUserId: agent.ownerUserId,
    path: 'agents',
  });
  const explicitOwnerUserId = explicitIdentity.ownerUserId || '';
  const explicitCanonicalId = explicitIdentity.canonicalId || '';
  const shouldReplaceDefaultIdentity =
    !explicitOwnerUserId &&
    !explicitCanonicalId &&
    Boolean(normalizedOwner) &&
    isDefaultPlaceholderIdentity(existingAgent);
  const existingOwnerUserId = shouldReplaceDefaultIdentity
    ? undefined
    : existingAgent?.ownerUserId;
  const existingCanonicalId = shouldReplaceDefaultIdentity
    ? undefined
    : existingAgent?.canonicalId;
  const compatibleExistingOwnerUserId =
    explicitCanonicalId && !explicitOwnerUserId
      ? ownerUserIdMatchesCanonicalAgentId(
          explicitCanonicalId,
          existingOwnerUserId,
        )
        ? existingOwnerUserId
        : undefined
      : existingOwnerUserId;
  const normalizedOwnerUserId =
    explicitOwnerUserId || compatibleExistingOwnerUserId || null;
  const identity = explicitCanonicalId
    ? null
    : allocateCanonicalAgentIdentity({
        database: getAgentDatabase(),
        agentId: normalizedId,
        owner: normalizedOwner,
        ownerUserId: normalizedOwnerUserId,
      });
  const canonicalId =
    explicitCanonicalId || existingCanonicalId || identity?.canonicalId || null;
  const ownerUserId = normalizedOwnerUserId || identity?.ownerUserId || null;
  const enableRag =
    typeof agent.enableRag === 'boolean' ? (agent.enableRag ? 1 : 0) : null;
  getAgentDatabase()
    .prepare(
      `INSERT INTO agents (
       id,
       archived,
       canonical_id,
       owner_user_id,
       name,
       display_name,
       image_asset,
       empty_chat_header,
       model,
       skills,
       chatbot_id,
       enable_rag,
       workspace,
       owner,
       role,
       reports_to,
       delegates_to,
       peers,
       cv,
       escalation_target,
       a2a,
       proxy,
       created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       archived = excluded.archived,
       canonical_id = excluded.canonical_id,
       owner_user_id = excluded.owner_user_id,
       name = excluded.name,
       display_name = excluded.display_name,
       image_asset = excluded.image_asset,
       empty_chat_header = excluded.empty_chat_header,
       model = excluded.model,
       skills = excluded.skills,
       chatbot_id = excluded.chatbot_id,
       enable_rag = excluded.enable_rag,
       workspace = excluded.workspace,
       owner = excluded.owner,
       role = excluded.role,
       reports_to = excluded.reports_to,
       delegates_to = excluded.delegates_to,
       peers = excluded.peers,
       cv = excluded.cv,
       escalation_target = excluded.escalation_target,
       a2a = excluded.a2a,
       proxy = excluded.proxy,
       updated_at = datetime('now')`,
    )
    .run(
      normalizedId,
      archived,
      canonicalId,
      ownerUserId,
      normalizedName,
      normalizedDisplayName,
      normalizedImageAsset,
      normalizedEmptyChatHeader,
      normalizedModel,
      normalizedSkills,
      normalizedChatbotId,
      enableRag,
      normalizedWorkspace,
      normalizedOwner,
      normalizedRole,
      normalizedReportsTo,
      normalizedDelegatesTo,
      normalizedPeers,
      normalizedCv,
      normalizedEscalationTarget,
      normalizedA2A,
      normalizedProxy,
    );
  const storedAgent = getAgentById(normalizedId);
  if (!storedAgent) {
    throw new Error(`Failed to read persisted agent: ${normalizedId}`);
  }
  return storedAgent;
}

export function setAgentArchived(
  agentId: string,
  archived: boolean,
): AgentConfig | null {
  const normalizedAgentId = agentId.trim();
  if (!normalizedAgentId) return null;
  const result = getAgentDatabase()
    .prepare(
      `UPDATE agents
       SET archived = ?, updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(archived ? 1 : 0, normalizedAgentId);
  return result.changes === 1 ? getAgentById(normalizedAgentId) : null;
}

export function upsertAgentWithTeamRevision(params: {
  agent: AgentConfig;
  finalAgents: AgentConfig[];
  meta: RuntimeConfigChangeMeta;
}): AgentConfig {
  return withRuntimeRevisionDatabaseAttached(() => {
    const upsert = getAgentDatabase().transaction(() => {
      syncAttachedTeamRevisionState(listAgents(), params.meta);
      const stored = upsertAgent(params.agent);
      syncAttachedTeamRevisionState(params.finalAgents, params.meta);
      return stored;
    });
    return upsert();
  });
}

export function upsertAgentsWithTeamRevision(params: {
  agents: AgentConfig[];
  finalAgents: AgentConfig[];
  meta: RuntimeConfigChangeMeta;
}): AgentConfig[] {
  return withRuntimeRevisionDatabaseAttached(() => {
    const upsert = getAgentDatabase().transaction(() => {
      syncAttachedTeamRevisionState(listAgents(), params.meta);
      for (const agent of params.agents) {
        upsertAgent(agent);
      }
      syncAttachedTeamRevisionState(params.finalAgents, params.meta);
      return listAgents();
    });
    return upsert();
  });
}

export function replaceAgentOrgChart(
  entries: AgentTeamStructureEntry[],
  revisionMeta?: RuntimeConfigChangeMeta,
): AgentConfig[] {
  const currentAgents = listAgents();
  const currentAgentIds = new Set(currentAgents.map((agent) => agent.id));
  const entriesById = new Map<string, AgentTeamStructureEntry>();
  for (const entry of entries) {
    const id = entry.id.trim();
    if (!id) {
      throw new Error('Team structure agent id is required.');
    }
    if (entriesById.has(id)) {
      throw new Error(
        `Team structure revision contains duplicate agent "${id}".`,
      );
    }
    if (!currentAgentIds.has(id)) {
      throw new Error(
        `Cannot restore team structure because agent "${id}" does not exist.`,
      );
    }
    entriesById.set(id, entry);
  }

  const nextAgentsById = new Map<string, AgentConfig>();
  for (const agent of currentAgents) {
    const entry = entriesById.get(agent.id);
    nextAgentsById.set(agent.id, {
      ...agent,
      role: entry?.role,
      reportsTo: entry?.reportsTo,
      delegatesTo: entry?.delegatesTo ? [...entry.delegatesTo] : undefined,
      peers: entry?.peers ? [...entry.peers] : undefined,
    });
  }
  const nextAgents = Array.from(nextAgentsById.values());
  validateAgentOrgChart(nextAgents);

  const updateOrgChart = getAgentDatabase().transaction(() => {
    if (revisionMeta) {
      syncAttachedTeamRevisionState(currentAgents, revisionMeta);
    }
    const statement = getAgentDatabase().prepare(
      `UPDATE agents
       SET role = ?,
           reports_to = ?,
           delegates_to = ?,
           peers = ?,
           updated_at = datetime('now')
       WHERE id = ?`,
    );
    for (const agent of nextAgents) {
      const result = statement.run(
        agent.role?.trim() || null,
        agent.reportsTo?.trim() || null,
        serializeAgentStringArray(agent.delegatesTo),
        serializeAgentStringArray(agent.peers),
        agent.id,
      );
      if (result.changes !== 1) {
        throw new Error(
          `Cannot restore team structure because agent "${agent.id}" does not exist.`,
        );
      }
    }
    if (revisionMeta) {
      syncAttachedTeamRevisionState(nextAgents, revisionMeta);
    }
  });
  if (revisionMeta) {
    withRuntimeRevisionDatabaseAttached(() => updateOrgChart());
  } else {
    updateOrgChart();
  }
  return listAgents();
}

export function deleteAgent(agentId: string): boolean {
  const normalizedAgentId = agentId.trim();
  if (!normalizedAgentId || normalizedAgentId === DEFAULT_AGENT_ID) {
    return false;
  }
  return (
    getAgentDatabase()
      .prepare('DELETE FROM agents WHERE id = ?')
      .run(normalizedAgentId).changes > 0
  );
}

export function deleteAgentWithTeamRevision(params: {
  agentId: string;
  finalAgents: AgentConfig[];
  meta: RuntimeConfigChangeMeta;
}): boolean {
  return withRuntimeRevisionDatabaseAttached(() => {
    const deleteWithRevision = getAgentDatabase().transaction(() => {
      syncAttachedTeamRevisionState(listAgents(), params.meta);
      const deleted = deleteAgent(params.agentId);
      if (deleted) {
        syncAttachedTeamRevisionState(params.finalAgents, params.meta);
      }
      return deleted;
    });
    return deleteWithRevision();
  });
}
