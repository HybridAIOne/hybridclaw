import type Database from 'better-sqlite3';
import { normalizePrincipal } from '../identity/principal.js';
import { withMemoryDatabase } from '../memory/db.js';

export const AGENT_GRANT_SOURCES = ['local', 'platform'] as const;

export type AgentGrantSource = (typeof AGENT_GRANT_SOURCES)[number];
export type AgentGrantRole = 'user';

export interface AgentGrant {
  agent_id: string;
  principal: string;
  role: AgentGrantRole;
  source: AgentGrantSource;
  granted_by: string;
  granted_at: string;
  synced_at: string | null;
  expires_at: string | null;
}

export interface UpsertAgentGrantInput {
  agentId: string;
  principal: unknown;
  role?: AgentGrantRole;
  source?: AgentGrantSource;
  grantedBy: string;
  grantedAt?: string | Date;
  syncedAt?: string | Date | null;
  expiresAt?: string | Date | null;
}

interface AgentGrantExpiryRow {
  expires_at: string | null;
}

export interface AgentGrantChange {
  agentId: string;
  principal: string;
}

type AgentGrantChangeListener = (change: AgentGrantChange) => void;

const agentGrantChangeListeners = new Set<AgentGrantChangeListener>();

const AGENT_GRANT_SELECT_COLUMNS =
  'agent_id, principal, role, source, granted_by, granted_at, synced_at, expires_at';

function normalizeAgentId(value: string): string {
  const agentId = value.trim();
  if (!agentId) throw new Error('Agent id is required.');
  return agentId;
}

function normalizeAgentGrantSource(value: unknown): AgentGrantSource {
  const source = String(value || 'local').trim();
  if (source === 'local' || source === 'platform') return source;
  throw new Error('Agent grant source must be `local` or `platform`.');
}

function normalizeAgentGrantRole(value: unknown): AgentGrantRole {
  const role = String(value || 'user').trim();
  if (role === 'user') return role;
  throw new Error('Agent grant role must be `user`.');
}

function normalizeGrantedBy(value: string): string {
  const grantedBy = value.trim();
  if (!grantedBy) throw new Error('Agent grant `grantedBy` is required.');
  return grantedBy;
}

function normalizeTimestamp(
  value: string | Date | undefined,
  field: string,
  fallback: Date,
): string {
  const candidate = value instanceof Date ? value : new Date(value ?? fallback);
  if (Number.isNaN(candidate.getTime())) {
    throw new Error(`Agent grant \`${field}\` must be a valid date.`);
  }
  return candidate.toISOString();
}

function normalizeOptionalTimestamp(
  value: string | Date | null | undefined,
  field: string,
): string | null {
  if (value === null || value === undefined) return null;
  return normalizeTimestamp(value, field, new Date());
}

function isActiveExpiry(expiresAt: string | null, now: Date): boolean {
  if (!expiresAt) return true;
  const timestamp = Date.parse(expiresAt);
  return Number.isFinite(timestamp) && timestamp > now.getTime();
}

function notifyAgentGrantChanged(change: AgentGrantChange): void {
  queueMicrotask(() => {
    for (const listener of agentGrantChangeListeners) listener(change);
  });
}

export function subscribeAgentGrantChanges(
  listener: AgentGrantChangeListener,
): () => void {
  agentGrantChangeListeners.add(listener);
  return () => agentGrantChangeListeners.delete(listener);
}

export function isAgentGrantActive(
  grant: Pick<AgentGrant, 'expires_at'>,
  options: { now?: Date } = {},
): boolean {
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) return false;
  return isActiveExpiry(grant.expires_at, now);
}

function readAgentGrant(
  database: Database.Database,
  agentId: string,
  principal: string,
): AgentGrant | null {
  return (
    database
      .prepare<[string, string], AgentGrant>(
        `SELECT ${AGENT_GRANT_SELECT_COLUMNS}
         FROM agent_grants
         WHERE agent_id = ? AND principal = ?`,
      )
      .get(agentId, principal) ?? null
  );
}

function requireStoredAgent(
  database: Database.Database,
  agentId: string,
): void {
  const row = database
    .prepare<[string], { id: string }>('SELECT id FROM agents WHERE id = ?')
    .get(agentId);
  if (!row) throw new Error(`Agent "${agentId}" was not found.`);
}

function reconcileStoredAgentSharedState(
  database: Database.Database,
  agentId: string,
  now: Date,
): boolean {
  const grants = database
    .prepare<[string], AgentGrantExpiryRow>(
      'SELECT expires_at FROM agent_grants WHERE agent_id = ?',
    )
    .all(agentId);
  const shared = grants.some((grant) => isActiveExpiry(grant.expires_at, now));
  database
    .prepare(
      `UPDATE agents
       SET shared = ?, updated_at = datetime('now')
       WHERE id = ? AND shared != ?`,
    )
    .run(shared ? 1 : 0, agentId, shared ? 1 : 0);
  return shared;
}

export function reconcileAgentSharedState(
  agentId: string,
  options: { now?: Date } = {},
): boolean {
  const normalizedAgentId = normalizeAgentId(agentId);
  const now = options.now ?? new Date();
  return withMemoryDatabase((database) => {
    requireStoredAgent(database, normalizedAgentId);
    return reconcileStoredAgentSharedState(database, normalizedAgentId, now);
  });
}

export function setAgentShared(agentId: string, shared: boolean): boolean {
  const normalizedAgentId = normalizeAgentId(agentId);
  return withMemoryDatabase(
    (database) =>
      database
        .prepare(
          "UPDATE agents SET shared = ?, updated_at = datetime('now') WHERE id = ?",
        )
        .run(shared ? 1 : 0, normalizedAgentId).changes > 0,
  );
}

export function upsertAgentGrant(input: UpsertAgentGrantInput): AgentGrant {
  const agentId = normalizeAgentId(input.agentId);
  const principal = normalizePrincipal(input.principal);
  const role = normalizeAgentGrantRole(input.role);
  const source = normalizeAgentGrantSource(input.source);
  const grantedBy = normalizeGrantedBy(input.grantedBy);
  const grantedAt = normalizeTimestamp(
    input.grantedAt,
    'grantedAt',
    new Date(),
  );
  const syncedAt = normalizeOptionalTimestamp(input.syncedAt, 'syncedAt');
  const expiresAt = normalizeOptionalTimestamp(input.expiresAt, 'expiresAt');
  const now = new Date();

  const grant = withMemoryDatabase((database) =>
    database.transaction(() => {
      requireStoredAgent(database, agentId);
      database
        .prepare(
          `INSERT INTO agent_grants (
             agent_id,
             principal,
             role,
             source,
             granted_by,
             granted_at,
             synced_at,
             expires_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(agent_id, principal) DO UPDATE SET
             role = excluded.role,
             source = excluded.source,
             granted_by = excluded.granted_by,
             granted_at = excluded.granted_at,
             synced_at = excluded.synced_at,
             expires_at = excluded.expires_at`,
        )
        .run(
          agentId,
          principal,
          role,
          source,
          grantedBy,
          grantedAt,
          syncedAt,
          expiresAt,
        );
      reconcileStoredAgentSharedState(database, agentId, now);
      const grant = readAgentGrant(database, agentId, principal);
      if (!grant) throw new Error('Agent grant was not persisted.');
      return grant;
    })(),
  );
  notifyAgentGrantChanged({ agentId, principal });
  return grant;
}

export function getAgentGrant(
  agentId: string,
  principal: unknown,
  options: { now?: Date } = {},
): AgentGrant | null {
  const normalizedAgentId = normalizeAgentId(agentId);
  const normalizedPrincipal = normalizePrincipal(principal);
  return withMemoryDatabase((database) => {
    const grant = readAgentGrant(
      database,
      normalizedAgentId,
      normalizedPrincipal,
    );
    reconcileStoredAgentSharedState(
      database,
      normalizedAgentId,
      options.now ?? new Date(),
    );
    return grant;
  });
}

export function listAgentGrants(agentId: string): AgentGrant[] {
  const normalizedAgentId = normalizeAgentId(agentId);
  return withMemoryDatabase((database) => {
    const grants = database
      .prepare<[string], AgentGrant>(
        `SELECT ${AGENT_GRANT_SELECT_COLUMNS}
         FROM agent_grants
         WHERE agent_id = ?
         ORDER BY principal ASC`,
      )
      .all(normalizedAgentId);
    reconcileStoredAgentSharedState(database, normalizedAgentId, new Date());
    return grants;
  });
}

export function listAgentGrantsForPrincipal(
  principal: unknown,
  options: { includeExpired?: boolean; now?: Date } = {},
): AgentGrant[] {
  const normalizedPrincipal = normalizePrincipal(principal);
  const now = options.now ?? new Date();
  const grants = withMemoryDatabase((database) => {
    const rows = database
      .prepare<[string], AgentGrant>(
        `SELECT ${AGENT_GRANT_SELECT_COLUMNS}
         FROM agent_grants
         WHERE principal = ?
         ORDER BY agent_id ASC`,
      )
      .all(normalizedPrincipal);
    for (const agentId of new Set(rows.map((grant) => grant.agent_id))) {
      reconcileStoredAgentSharedState(database, agentId, now);
    }
    return rows;
  });
  return options.includeExpired
    ? grants
    : grants.filter((grant) => isAgentGrantActive(grant, { now }));
}

export function hasActiveAgentGrant(
  agentId: string,
  principal: unknown,
  options: { now?: Date } = {},
): boolean {
  const grant = getAgentGrant(agentId, principal, options);
  return grant ? isAgentGrantActive(grant, options) : false;
}

export function deleteAgentGrant(
  agentId: string,
  principal: unknown,
  options: { now?: Date } = {},
): AgentGrant | null {
  const normalizedAgentId = normalizeAgentId(agentId);
  const normalizedPrincipal = normalizePrincipal(principal);
  const now = options.now ?? new Date();

  const deleted = withMemoryDatabase((database) =>
    database.transaction(() => {
      const existing = readAgentGrant(
        database,
        normalizedAgentId,
        normalizedPrincipal,
      );
      if (!existing) return null;
      database
        .prepare(
          'DELETE FROM agent_grants WHERE agent_id = ? AND principal = ?',
        )
        .run(normalizedAgentId, normalizedPrincipal);
      reconcileStoredAgentSharedState(database, normalizedAgentId, now);
      return existing;
    })(),
  );
  if (deleted) {
    notifyAgentGrantChanged({
      agentId: normalizedAgentId,
      principal: normalizedPrincipal,
    });
  }
  return deleted;
}
