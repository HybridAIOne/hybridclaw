/**
 * Scopes — the user's named compartments for side chats ("Work", "Family").
 * A scoped chat keeps its own memory and sees only the connectors the scope
 * lists. Rows live in SQLite, never in a workspace file the model can edit,
 * and only the user (over `/api/scopes`) creates, renames or deletes one.
 *
 * NOT the session's binding to a scope (`scope-session.ts`) or the scope's
 * files (`scope-workspace.ts`): deleting a row here leaves sessions pointing
 * at it, which is how a later turn learns its scope was deleted.
 */
import { randomBytes } from 'node:crypto';
import { SCOPE_ID_RE } from '../../container/shared/scope-dirs.js';
import { withMemoryDatabase } from '../memory/database.js';
import { queryAll, queryOne } from '../memory/sqlite.js';

export interface Scope {
  id: string;
  name: string;
  connectors: string[];
  createdAt: string;
}

export type ScopeErrorCode =
  | 'invalid_scope'
  | 'scope_exists'
  | 'scope_not_found'
  | 'too_many_scopes';

export class ScopeError extends Error {
  constructor(
    readonly code: ScopeErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface ScopeRow {
  id: string;
  agent_id: string;
  name: string;
  connectors_json: string;
  created_at: string;
}

// Limits (engineering choice, 2026-10-09): a handful of life areas, not
// folders; a connector id is a platform directory id or "device".
const MAX_SCOPES_PER_AGENT = 50;
const MAX_NAME_LENGTH = 40;
const MAX_CONNECTORS = 50;
const CONNECTOR_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** The pseudo connector id for the phone's on-device data (`device_data`). */
export const DEVICE_CONNECTOR_ID = 'device';

export function isScopeId(value: unknown): value is string {
  return typeof value === 'string' && SCOPE_ID_RE.test(value);
}

function toScope(row: ScopeRow): Scope {
  let connectors: string[] = [];
  try {
    const parsed = JSON.parse(row.connectors_json) as unknown;
    if (Array.isArray(parsed)) {
      connectors = parsed.filter((id): id is string => typeof id === 'string');
    }
  } catch {
    connectors = [];
  }
  return {
    id: row.id,
    name: row.name,
    connectors,
    createdAt: row.created_at,
  };
}

export function normalizeScopeName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || [...name].length > MAX_NAME_LENGTH) {
    throw new ScopeError(
      'invalid_scope',
      `A scope name has 1 to ${MAX_NAME_LENGTH} characters.`,
    );
  }
  return name;
}

export function normalizeScopeConnectors(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new ScopeError(
      'invalid_scope',
      '`connectors` must be an array of connector ids.',
    );
  }
  const connectors: string[] = [];
  for (const entry of value) {
    const id = typeof entry === 'string' ? entry.trim().toLowerCase() : '';
    if (!CONNECTOR_ID_RE.test(id)) {
      throw new ScopeError(
        'invalid_scope',
        `Invalid connector id: ${JSON.stringify(entry)}.`,
      );
    }
    if (!connectors.includes(id)) connectors.push(id);
  }
  if (connectors.length > MAX_CONNECTORS) {
    throw new ScopeError(
      'invalid_scope',
      `A scope lists at most ${MAX_CONNECTORS} connectors.`,
    );
  }
  return connectors;
}

function nameKey(name: string): string {
  return name.toLocaleLowerCase('en');
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed: scopes\.agent_id, scopes\.name_key/.test(
      error.message,
    )
  );
}

function duplicateName(name: string): ScopeError {
  return new ScopeError('scope_exists', `A scope named "${name}" exists.`);
}

export function listScopes(agentId: string): Scope[] {
  return withMemoryDatabase((database) =>
    queryAll<ScopeRow, [string]>(
      database,
      `SELECT * FROM scopes WHERE agent_id = ?
       ORDER BY created_at ASC, id ASC`,
      agentId,
    ).map(toScope),
  );
}

/** Every scope's agent and id, for matching scope runtime tokens. */
export function listAllScopeKeys(): Array<{
  agentId: string;
  scopeId: string;
}> {
  return withMemoryDatabase((database) =>
    queryAll<{ agent_id: string; id: string }>(
      database,
      'SELECT agent_id, id FROM scopes',
    ).map((row) => ({ agentId: row.agent_id, scopeId: row.id })),
  );
}

export function getScope(agentId: string, scopeId: string): Scope | null {
  if (!isScopeId(scopeId)) return null;
  const row = withMemoryDatabase((database) =>
    queryOne<ScopeRow, [string, string]>(
      database,
      'SELECT * FROM scopes WHERE id = ? AND agent_id = ?',
      scopeId,
      agentId,
    ),
  );
  return row ? toScope(row) : null;
}

export function createScope(params: {
  agentId: string;
  name: unknown;
  connectors: unknown;
}): Scope {
  const name = normalizeScopeName(params.name);
  const connectors = normalizeScopeConnectors(params.connectors ?? []);
  const id = `s_${randomBytes(6).toString('hex')}`;
  const createdAt = new Date().toISOString();
  withMemoryDatabase((database) => {
    const count =
      queryOne<{ count: number }, [string]>(
        database,
        'SELECT COUNT(*) AS count FROM scopes WHERE agent_id = ?',
        params.agentId,
      )?.count ?? 0;
    if (count >= MAX_SCOPES_PER_AGENT) {
      throw new ScopeError(
        'too_many_scopes',
        `An agent has at most ${MAX_SCOPES_PER_AGENT} scopes.`,
      );
    }
    try {
      database
        .prepare(
          `INSERT INTO scopes (id, agent_id, name, name_key, connectors_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          params.agentId,
          name,
          nameKey(name),
          JSON.stringify(connectors),
          createdAt,
        );
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicateName(name);
      throw error;
    }
  });
  return { id, name, connectors, createdAt };
}

export function updateScope(params: {
  agentId: string;
  scopeId: string;
  name?: unknown;
  connectors?: unknown;
}): Scope {
  const existing = getScope(params.agentId, params.scopeId);
  if (!existing) {
    throw new ScopeError('scope_not_found', 'No such scope.');
  }
  const name =
    params.name === undefined ? existing.name : normalizeScopeName(params.name);
  const connectors =
    params.connectors === undefined
      ? existing.connectors
      : normalizeScopeConnectors(params.connectors);
  withMemoryDatabase((database) => {
    try {
      database
        .prepare(
          `UPDATE scopes SET name = ?, name_key = ?, connectors_json = ?
           WHERE id = ? AND agent_id = ?`,
        )
        .run(
          name,
          nameKey(name),
          JSON.stringify(connectors),
          existing.id,
          params.agentId,
        );
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicateName(name);
      throw error;
    }
  });
  return { ...existing, name, connectors };
}

/** Deletes the row; the caller erases the scope's workspace. */
export function deleteScopeRow(agentId: string, scopeId: string): boolean {
  if (!isScopeId(scopeId)) return false;
  return withMemoryDatabase(
    (database) =>
      database
        .prepare('DELETE FROM scopes WHERE id = ? AND agent_id = ?')
        .run(scopeId, agentId).changes > 0,
  );
}
