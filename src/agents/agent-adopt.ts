/**
 * Agent adoption — one agent takes over another's user: a copy of its
 * workspace, its sessions, tasks and agent-scoped memory, the default-agent
 * slot and its mailbox. The adopting agent never runs onboarding afterwards.
 *
 * Adoption happens once per pair (a marker in the adopting workspace makes a
 * repeat a no-op) and only when the old agent holds user data, so a new user
 * keeps a clean start. The old agent's workspace stays as a backup.
 *
 * NOT agent reset (`agent-reset.ts`), which deletes; nothing here deletes data.
 */
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getInFlightExecutorSessionIds } from '../agent/executor.js';
import {
  flushAuditTrail,
  forgetAuditSessionState,
  getAuditSessionDir,
} from '../audit/audit-trail.js';
import { DATA_DIR } from '../config/config.js';
import {
  getRuntimeConfig,
  updateRuntimeConfig,
} from '../config/runtime-config.js';
import { ACTIVE_AGENT_KEY_PREFIX } from '../gateway/agent-addressing.js';
import { interruptGatewaySessionExecution } from '../gateway/gateway-request-runtime.js';
import { renameWebNotificationSession } from '../gateway/web-notification-store.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import { renameArchives } from '../memory/compaction-archive.js';
import { withMemoryDatabase } from '../memory/db.js';
import { mergeCanonicalSessionsInto } from '../memory/schema/migrations.js';
import { renameTodoOwners } from '../todos/todo-store.js';
import { renameTrackedOwners } from '../tracking/track-store.js';
import { expandHomePath } from '../utils/path.js';
import {
  PROACTIVE_PREFERENCES_FILE,
  readWorkspaceTemplate,
  WORKSPACE_BOOTSTRAP_FILES,
} from '../workspace-templates.js';
import { turnOffAgentOnboarding } from './agent-onboarding.js';
import { getAgentById, listAgents } from './agent-registry.js';
import { requireOwnManagedWorkspace } from './agent-reset.js';
import { activateAgentInRuntimeConfig } from './agent-runtime-config.js';
import { DEFAULT_AGENT_ID } from './agent-types.js';

export interface AdoptSessionPair {
  from: string;
  to: string;
}

export type AdoptAgentResult =
  | { status: 'already' | 'nothing'; from: string; to: string }
  | {
      status: 'adopted';
      from: string;
      to: string;
      adoptedAt: string;
      sessionsMoved: number;
      threadsRenamed: number;
      /** Sessions of `to` that were in a renamed thread's way, and their new ids. */
      movedAside: AdoptSessionPair[];
      filesCopied: number;
    };

/** `status` is the HTTP status the admin route answers with. */
export class AgentAdoptError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409,
  ) {
    super(message);
  }
}

const AGENT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const SESSION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,255}$/;
const MARKER_PATH = path.join('.hybridclaw', 'adopted-from.json');
// The adopting agent's own persona and runtime files (owner call,
// 2026-10-07): everything else in the old workspace is the user's.
const USER_TEMPLATE_FILES = new Set<string>([
  'USER.md',
  'MEMORY.md',
  PROACTIVE_PREFERENCES_FILE,
  'HEARTBEAT.md',
]);
const KEPT_PATHS = new Set<string>([
  ...WORKSPACE_BOOTSTRAP_FILES.filter((name) => !USER_TEMPLATE_FILES.has(name)),
  'node_modules',
  '.hybridclaw/workspace-state.json',
  '.hybridclaw/adopted-from.json',
]);

function fail(message: string, status: 400 | 409 = 400): never {
  throw new AgentAdoptError(message, status);
}

function readMarkerFrom(workspace: string): string | null {
  try {
    const marker = JSON.parse(
      fs.readFileSync(path.join(workspace, MARKER_PATH), 'utf8'),
    ) as { from?: unknown };
    return typeof marker.from === 'string' ? marker.from : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** SQL matching the sessions an agent owns; `main` also owns unassigned ones. */
function ownedBy(agentId: string): { where: string; params: string[] } {
  return agentId === DEFAULT_AGENT_ID
    ? {
        where: "(agent_id = ? OR agent_id IS NULL OR TRIM(agent_id) = '')",
        params: [agentId],
      }
    : { where: 'agent_id = ?', params: [agentId] };
}

function hasUserFiles(dir: string, relative = ''): boolean {
  if (!fs.existsSync(dir)) return false;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (KEPT_PATHS.has(rel) || rel === '.hybridclaw') continue;
    if (entry.name === '.DS_Store') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (hasUserFiles(full, rel)) return true;
      continue;
    }
    if (USER_TEMPLATE_FILES.has(rel)) {
      const content = fs.readFileSync(full, 'utf8').trim();
      if (content && content !== readWorkspaceTemplate(rel)?.trim()) {
        return true;
      }
      continue;
    }
    return true;
  }
  return false;
}

// Memory the adopting agent already wrote stays, below the imported memory
// (owner call, 2026-10-07); every other same-named file is replaced.
const MERGED_FILE_RE = /^(MEMORY\.md|memory\/[^/]+\.md)$/;

function mergedMemory(
  rel: string,
  from: string,
  to: string,
  heading: string,
): string | null {
  if (!MERGED_FILE_RE.test(rel) || !fs.existsSync(to)) return null;
  if (!fs.lstatSync(to).isFile()) return null;
  const kept = fs.readFileSync(to, 'utf8').trim();
  const imported = fs.readFileSync(from, 'utf8');
  if (
    !kept ||
    kept === imported.trim() ||
    kept === readWorkspaceTemplate(rel)?.trim()
  ) {
    return null;
  }
  return `${imported.trimEnd()}\n\n${heading}\n\n${kept}\n`;
}

function copyUserFiles(
  source: string,
  target: string,
  heading: string,
  relative = '',
): number {
  let copied = 0;
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (KEPT_PATHS.has(rel)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      if (fs.existsSync(to) && !fs.lstatSync(to).isDirectory()) fs.rmSync(to);
      copied += copyUserFiles(from, to, heading, rel);
      continue;
    }
    const merged = entry.isFile() ? mergedMemory(rel, from, to, heading) : null;
    if (merged !== null) {
      fs.writeFileSync(to, merged);
      copied += 1;
      continue;
    }
    fs.rmSync(to, { recursive: true, force: true });
    if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(from), to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    } else {
      continue;
    }
    copied += 1;
  }
  return copied;
}

function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Every column holding a session id or session key, found from the schema so
 * a table added later is not missed. FTS mirrors follow their triggers.
 */
function sessionColumns(db: Database.Database): Array<[string, string]> {
  const columns: Array<[string, string]> = [
    ['sessions', 'id'],
    ['sessions', 'session_key'],
    ['sessions', 'main_session_key'],
    ['sessions', 'legacy_session_id'],
    // Session-scoped memory uses the session id as its scope.
    ['kv_store', 'agent_id'],
  ];
  const tables = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all() as Array<{ name: string; sql: string | null }>;
  for (const { name, sql } of tables) {
    if (/^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(sql ?? '')) continue;
    const info = db.prepare(`PRAGMA table_info(${quote(name)})`).all() as {
      name: string;
    }[];
    for (const column of info) {
      if (
        column.name === 'session_id' ||
        column.name === 'parent_session_id' ||
        (name === 'thread_goals' && column.name === 'thread_id')
      ) {
        columns.push([name, column.name]);
      }
    }
  }
  return columns.filter(([table, column]) =>
    (
      db.prepare(`PRAGMA table_info(${quote(table)})`).all() as {
        name: string;
      }[]
    ).some((info) => info.name === column),
  );
}

function sessionExists(db: Database.Database, id: string): boolean {
  return Boolean(
    db
      .prepare(
        'SELECT 1 FROM sessions WHERE id = ? OR session_key = ? OR main_session_key = ? OR legacy_session_id = ? LIMIT 1',
      )
      .get(id, id, id, id),
  );
}

function renameSessionId(
  db: Database.Database,
  columns: Array<[string, string]>,
  from: string,
  to: string,
): void {
  for (const [table, column] of columns) {
    db.prepare(
      `UPDATE ${quote(table)} SET ${quote(column)} = ? WHERE ${quote(column)} = ?`,
    ).run(to, from);
  }
  db.prepare('UPDATE OR REPLACE kv_store SET key = ? WHERE key = ?').run(
    `${ACTIVE_AGENT_KEY_PREFIX}${to}`,
    `${ACTIVE_AGENT_KEY_PREFIX}${from}`,
  );
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table),
  );
}

/** Rewrites a leading `fromPrefix` to `toPrefix` in one column. */
function rewritePrefix(
  db: Database.Database,
  table: string,
  column: string,
  fromPrefix: string,
  toPrefix: string,
): void {
  db.prepare(
    `UPDATE OR IGNORE ${quote(table)} SET ${quote(column)} = ? || substr(${quote(column)}, ?) WHERE substr(${quote(column)}, 1, ?) = ?`,
  ).run(toPrefix, fromPrefix.length + 1, fromPrefix.length, fromPrefix);
}

/** Moves kv rows between scopes; the moved row wins over the target's. */
function moveKvScopes(
  db: Database.Database,
  pick: string,
  params: unknown[],
  nextScope: (scope: string) => string,
): void {
  const rows = db
    .prepare(`SELECT agent_id, key FROM kv_store WHERE ${pick}`)
    .all(...params) as Array<{ agent_id: string; key: string }>;
  const remove = db.prepare(
    'DELETE FROM kv_store WHERE agent_id = ? AND key = ?',
  );
  const move = db.prepare(
    'UPDATE kv_store SET agent_id = ? WHERE agent_id = ? AND key = ?',
  );
  for (const row of rows) {
    const scope = nextScope(row.agent_id);
    if (scope === row.agent_id) continue;
    remove.run(scope, row.key);
    move.run(scope, row.agent_id, row.key);
  }
}

function moveDatabaseRows(params: {
  from: string;
  to: string;
  pairs: AdoptSessionPair[];
  asideSuffix: string;
}): { sessionsMoved: number; renames: AdoptSessionPair[] } {
  const { from, to } = params;
  return withMemoryDatabase((db) =>
    db.transaction(() => {
      const columns = sessionColumns(db);
      const renames: AdoptSessionPair[] = [];
      for (const pair of params.pairs) {
        if (!sessionExists(db, pair.from)) continue;
        if (sessionExists(db, pair.to)) {
          const aside = `${pair.to}${params.asideSuffix}`;
          renameSessionId(db, columns, pair.to, aside);
          renames.push({ from: pair.to, to: aside });
        }
        renameSessionId(db, columns, pair.from, pair.to);
        renames.push(pair);
      }

      const owner = ownedBy(from);
      const fromKey = `agent:${from}:`;
      const toKey = `agent:${to}:`;
      // The old agent's thread stays current where both had the same key.
      db.prepare(
        `UPDATE sessions SET is_current = 0
         WHERE agent_id = ? AND is_current = 1 AND session_key IN (
           SELECT ? || substr(session_key, ?) FROM sessions
           WHERE ${owner.where} AND is_current = 1 AND substr(session_key, 1, ?) = ?
         )`,
      ).run(
        to,
        toKey,
        fromKey.length + 1,
        ...owner.params,
        fromKey.length,
        fromKey,
      );
      const sessionsMoved = db
        .prepare(`UPDATE sessions SET agent_id = ? WHERE ${owner.where}`)
        .run(to, ...owner.params).changes;
      rewritePrefix(db, 'sessions', 'session_key', fromKey, toKey);
      rewritePrefix(db, 'sessions', 'main_session_key', fromKey, toKey);
      if (tableExists(db, 'thread_goals')) {
        rewritePrefix(db, 'thread_goals', 'thread_id', fromKey, toKey);
      }
      db.prepare(
        'UPDATE messages SET agent_id = ? WHERE agent_id = ? AND session_id IN (SELECT id FROM sessions WHERE agent_id = ?)',
      ).run(to, from, to);

      moveKvScopes(db, 'agent_id = ?', [from], () => to);
      moveKvScopes(
        db,
        'substr(agent_id, 1, ?) = ?',
        [fromKey.length, fromKey],
        (scope) => `${toKey}${scope.slice(fromKey.length)}`,
      );
      const activeKey = `${ACTIVE_AGENT_KEY_PREFIX}${fromKey}`;
      db.prepare(
        `UPDATE OR REPLACE kv_store SET key = ? || substr(key, ?) WHERE substr(key, 1, ?) = ?`,
      ).run(
        `${ACTIVE_AGENT_KEY_PREFIX}${toKey}`,
        activeKey.length + 1,
        activeKey.length,
        activeKey,
      );
      db.prepare(
        'UPDATE kv_store SET value = ? WHERE substr(key, 1, ?) = ? AND CAST(value AS TEXT) = ?',
      ).run(
        Buffer.from(JSON.stringify(to)),
        ACTIVE_AGENT_KEY_PREFIX.length,
        ACTIVE_AGENT_KEY_PREFIX,
        JSON.stringify(from),
      );

      mergeCanonicalSessionsInto(db, to, [to, from]);
      for (const [table, column] of [
        ['jobs', 'agent_id'],
        ['delegation_jobs', 'agent_id'],
        ['apps', 'agent_id'],
        ['work_records', 'agent_id'],
        ['thread_goals', 'target_agent_id'],
      ] as const) {
        if (!tableExists(db, table)) continue;
        db.prepare(
          `UPDATE ${quote(table)} SET ${quote(column)} = ? WHERE ${quote(column)} = ?`,
        ).run(to, from);
      }
      if (tableExists(db, 'board_cards')) {
        db.prepare(
          "UPDATE board_cards SET owner_id = ?, owner = ? WHERE owner_type = 'agent' AND owner_id = ?",
        ).run(to, JSON.stringify({ agentId: to }), from);
      }
      return { sessionsMoved, renames };
    })(),
  );
}

function moveAside(target: string, suffix: string): void {
  if (fs.existsSync(target)) fs.renameSync(target, `${target}${suffix}`);
}

function renameSessionFiles(
  renames: AdoptSessionPair[],
  asideSuffix: string,
): void {
  const sessionDir = (id: string) =>
    path.join(DATA_DIR, 'sessions', id.replace(/[^a-zA-Z0-9_-]/g, '_'));
  forgetAuditSessionState(renames.flatMap(({ from, to }) => [from, to]));
  for (const { from, to } of renames) {
    interruptGatewaySessionExecution(from);
    for (const dir of [sessionDir, getAuditSessionDir]) {
      if (!fs.existsSync(dir(from))) continue;
      moveAside(dir(to), asideSuffix);
      fs.renameSync(dir(from), dir(to));
    }
    renameArchives(from, to);
    renameWebNotificationSession(from, to);
  }
}

function moveRuntimeConfig(from: string, to: string, fromWs: string): void {
  const toAgent = getAgentById(to);
  if (toAgent) activateAgentInRuntimeConfig(toAgent);
  const config = getRuntimeConfig();
  const fromSkills = path.resolve(fromWs, 'skills');
  const isFromSkills = (dir: string) =>
    path.resolve(expandHomePath(dir)) === fromSkills;
  const fromMailbox = (agentId: string) =>
    (agentId.trim() || DEFAULT_AGENT_ID) === from;
  if (
    !config.email.accounts.some((account) => fromMailbox(account.agentId)) &&
    !config.skills.extraDirs.some(isFromSkills)
  ) {
    return;
  }
  updateRuntimeConfig(
    (draft) => {
      for (const account of draft.email.accounts) {
        if (fromMailbox(account.agentId)) account.agentId = to;
      }
      draft.skills.extraDirs = draft.skills.extraDirs.map((dir) =>
        isFromSkills(dir) ? path.resolve(agentWorkspaceDir(to), 'skills') : dir,
      );
    },
    { route: `agents.adopt#${to}`, source: 'agent-adopt' },
  );
}

function validatePairs(raw: AdoptSessionPair[]): AdoptSessionPair[] {
  const seen = new Set<string>();
  for (const pair of raw) {
    if (
      !SESSION_ID_RE.test(pair.from) ||
      !SESSION_ID_RE.test(pair.to) ||
      pair.from === pair.to ||
      seen.has(pair.from) ||
      seen.has(pair.to)
    ) {
      fail(`Invalid session pair ${pair.from}=${pair.to}.`);
    }
    seen.add(pair.from);
    seen.add(pair.to);
  }
  return raw;
}

export async function adoptAgent(params: {
  to: string;
  from?: string;
  sessions?: AdoptSessionPair[];
}): Promise<AdoptAgentResult> {
  const to = params.to.trim();
  const from = (params.from ?? DEFAULT_AGENT_ID).trim();
  if (!AGENT_ID_RE.test(to) || !AGENT_ID_RE.test(from)) {
    fail('Invalid agent id.');
  }
  if (to === DEFAULT_AGENT_ID) fail('The main agent cannot adopt an agent.');
  if (to === from) fail('An agent cannot adopt itself.');
  const pairs = validatePairs(params.sessions ?? []);
  if (!listAgents().some((agent) => agent.id === from)) {
    fail(`Agent "${from}" is not installed.`);
  }
  try {
    requireOwnManagedWorkspace(to, 'adopt');
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const toWs = agentWorkspaceDir(to);
  const fromWs = agentWorkspaceDir(from);
  if (path.resolve(fromWs) === path.resolve(toWs)) {
    fail('Both agents share one workspace.');
  }
  const adoptedFrom = readMarkerFrom(toWs);
  if (adoptedFrom === from) return { status: 'already', from, to };
  if (adoptedFrom) {
    fail(
      `Agent "${to}" already imported from "${adoptedFrom}"; reset it first.`,
      409,
    );
  }

  const owner = ownedBy(from);
  const hasUserMessages = withMemoryDatabase((db) =>
    Boolean(
      db
        .prepare(
          `SELECT 1 FROM messages WHERE role = 'user' AND session_id IN (
             SELECT id FROM sessions WHERE ${owner.where}
           ) LIMIT 1`,
        )
        .get(...owner.params),
    ),
  );
  if (!hasUserMessages && !hasUserFiles(fromWs)) {
    return { status: 'nothing', from, to };
  }

  // Everything after the flush runs synchronously, so no turn or audit
  // append can start halfway through.
  await flushAuditTrail();
  const busy = new Set(getInFlightExecutorSessionIds());
  const touched = withMemoryDatabase(
    (db) =>
      db
        .prepare(`SELECT id FROM sessions WHERE ${owner.where} OR agent_id = ?`)
        .all(...owner.params, to) as Array<{ id: string }>,
  ).map(({ id }) => id);
  if (
    [...touched, ...pairs.flatMap((pair) => [pair.from, pair.to])].some((id) =>
      busy.has(id),
    )
  ) {
    fail('An agent is busy. Retry once its running tasks finish.', 409);
  }

  const adoptedAt = new Date().toISOString();
  const asideSuffix = `-before-adopt-${Date.now()}`;
  const filesCopied = fs.existsSync(fromWs)
    ? copyUserFiles(
        fromWs,
        toWs,
        `## Before the import from ${from} (${adoptedAt.slice(0, 10)})`,
      )
    : 0;
  turnOffAgentOnboarding(to);
  const { sessionsMoved, renames } = moveDatabaseRows({
    from,
    to,
    pairs,
    asideSuffix,
  });
  renameSessionFiles(renames, asideSuffix);

  const renamed = new Map(renames.map((pair) => [pair.from, pair.to]));
  const nextSessionKey = (key: string) => {
    const id = renamed.get(key) ?? key;
    return id.startsWith(`agent:${from}:`)
      ? `agent:${to}:${id.slice(from.length + 7)}`
      : id;
  };
  const nextOwner = (owner: string) =>
    owner === `web:${from}`
      ? `web:${to}`
      : owner.startsWith('chat:')
        ? `chat:${nextSessionKey(owner.slice(5))}`
        : owner;
  renameTodoOwners(nextOwner);
  const fromPrefix = `${path.resolve(fromWs)}${path.sep}`;
  renameTrackedOwners(nextOwner, (resultPath) =>
    resultPath.startsWith(fromPrefix)
      ? path.join(toWs, resultPath.slice(fromPrefix.length))
      : resultPath,
  );
  moveRuntimeConfig(from, to, fromWs);

  const marker = path.join(toWs, MARKER_PATH);
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(
    marker,
    `${JSON.stringify({ from, adoptedAt, sessions: pairs }, null, 2)}\n`,
  );
  return {
    status: 'adopted',
    from,
    to,
    adoptedAt,
    sessionsMoved,
    threadsRenamed: renames.filter((pair) => !pair.to.endsWith(asideSuffix))
      .length,
    movedAside: renames.filter((pair) => pair.to.endsWith(asideSuffix)),
    filesCopied,
  };
}
