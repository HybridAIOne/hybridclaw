import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { DEFAULT_RUNTIME_HOME_DIR } from './runtime-paths.js';

const CONFIG_REVISION_DB_PATH = path.join(
  DEFAULT_RUNTIME_HOME_DIR,
  'data',
  'config-revisions.db',
);

const REVISION_SCHEMA_VERSION = 1;

export interface RuntimeConfigChangeMeta {
  actor?: string | null;
  route?: string | null;
  source?: string | null;
}

export interface RuntimeConfigRevisionSummary {
  id: number;
  actor: string;
  route: string;
  source: string;
  md5: string;
  byteLength: number;
  createdAt: string;
  replacedByMd5: string | null;
}

export interface RuntimeConfigRevision extends RuntimeConfigRevisionSummary {
  content: string;
}

export interface RuntimeConfigRevisionState {
  actor: string;
  route: string;
  source: string;
  content: string;
  updatedAt: string;
}

export interface RuntimeConfigRevisionStateMetadata {
  actor: string;
  route: string;
  source: string;
  updatedAt: string;
}

export interface RuntimeConfigObservedFile {
  exists: boolean;
  content: string | null;
  md5?: string | null;
}

interface ConfigRevisionRow {
  id: number;
  actor: string;
  route: string;
  source: string;
  md5: string;
  byte_length: number;
  content: string;
  created_at: string;
  replaced_by_md5: string | null;
}

interface ConfigRevisionSummaryRow {
  id: number;
  actor: string;
  route: string;
  source: string;
  md5: string;
  byte_length: number;
  created_at: string;
  replaced_by_md5: string | null;
}

interface ConfigRevisionTrackedStateRow {
  current_md5: string;
  current_content: string;
}

interface ConfigRevisionStateRow {
  current_content: string;
  actor: string;
  route: string;
  source: string;
  updated_at: string;
}

interface ConfigRevisionStateMetadataRow {
  actor: string;
  route: string;
  source: string;
  updated_at: string;
}

function resolveActor(actor?: string | null): string {
  const normalized = String(actor || '').trim();
  if (normalized) return normalized;
  const envUser =
    String(process.env.HYBRIDCLAW_CONFIG_ACTOR || '').trim() ||
    String(process.env.USER || '').trim() ||
    String(process.env.LOGNAME || '').trim();
  if (envUser) return envUser;
  try {
    return os.userInfo().username.trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

function detectRouteFromStack(): string | null {
  const stack = new Error().stack;
  if (!stack) return null;

  for (const line of stack.split('\n').slice(1)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('at ')) continue;
    if (
      trimmed.includes('runtime-config-revisions.') ||
      trimmed.includes('runtime-config.') ||
      trimmed.includes('node:internal')
    ) {
      continue;
    }
    return trimmed.replace(/^at\s+/, '');
  }

  return null;
}

function sanitizeDetectedRoute(route: string): string {
  const trimmed = route.trim();
  const callsiteMatch = trimmed.match(/^(.*?) \((.*)\)$/);
  if (callsiteMatch) {
    const functionName = String(callsiteMatch[1] || '').trim();
    if (functionName) return functionName;
    const location = String(callsiteMatch[2] || '').trim();
    const basenameMatch = location.match(/([^/\\]+:\d+:\d+)$/);
    if (basenameMatch) return basenameMatch[1];
    return location.replace(/^file:\/\//, '');
  }

  const basenameMatch = trimmed.match(/([^/\\]+:\d+:\d+)$/);
  if (basenameMatch) return basenameMatch[1];
  return trimmed.replace(/^file:\/\//, '');
}

function normalizeChangeMeta(
  meta?: RuntimeConfigChangeMeta,
): Required<RuntimeConfigChangeMeta> {
  const explicitRoute = String(meta?.route || '').trim();
  const detectedRoute = explicitRoute
    ? null
    : sanitizeDetectedRoute(detectRouteFromStack() || '');
  return {
    actor: resolveActor(meta?.actor),
    route: explicitRoute || detectedRoute || 'runtime-config.unspecified',
    source: String(meta?.source || '').trim() || 'internal',
  };
}

function computeMd5(content: string): string {
  return createHash('md5').update(content).digest('hex');
}

function withRevisionDatabase<T>(fn: (database: Database.Database) => T): T {
  fs.mkdirSync(path.dirname(CONFIG_REVISION_DB_PATH), { recursive: true });
  const database = new Database(CONFIG_REVISION_DB_PATH);
  try {
    database.pragma('journal_mode = WAL');
    database.pragma('busy_timeout = 5000');
    database.exec(`
      CREATE TABLE IF NOT EXISTS config_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        config_path TEXT NOT NULL,
        actor TEXT NOT NULL,
        route TEXT NOT NULL,
        source TEXT NOT NULL,
        md5 TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        content TEXT NOT NULL,
        replaced_by_md5 TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_config_revisions_path_id
        ON config_revisions(config_path, id DESC);
      CREATE TABLE IF NOT EXISTS config_revision_state (
        config_path TEXT PRIMARY KEY,
        current_md5 TEXT NOT NULL,
        current_content TEXT NOT NULL,
        actor TEXT NOT NULL,
        route TEXT NOT NULL,
        source TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const currentVersion = Number(
      database.pragma('user_version', { simple: true }) || 0,
    );
    if (currentVersion < REVISION_SCHEMA_VERSION) {
      database.pragma(`user_version = ${REVISION_SCHEMA_VERSION}`);
    }
    return fn(database);
  } finally {
    database.close();
  }
}

function mapRevisionRow(row: ConfigRevisionRow): RuntimeConfigRevision {
  return {
    id: row.id,
    actor: row.actor,
    route: row.route,
    source: row.source,
    md5: row.md5,
    byteLength: row.byte_length,
    content: row.content,
    createdAt: row.created_at,
    replacedByMd5: row.replaced_by_md5,
  };
}

function mapRevisionSummaryRow(
  row: ConfigRevisionSummaryRow,
): RuntimeConfigRevisionSummary {
  return {
    id: row.id,
    actor: row.actor,
    route: row.route,
    source: row.source,
    md5: row.md5,
    byteLength: row.byte_length,
    createdAt: row.created_at,
    replacedByMd5: row.replaced_by_md5,
  };
}

function mapRevisionStateRow(
  row: ConfigRevisionStateRow,
): RuntimeConfigRevisionState {
  return {
    actor: row.actor,
    route: row.route,
    source: row.source,
    content: row.current_content,
    updatedAt: row.updated_at,
  };
}

function mapRevisionStateMetadataRow(
  row: ConfigRevisionStateMetadataRow,
): RuntimeConfigRevisionStateMetadata {
  return {
    actor: row.actor,
    route: row.route,
    source: row.source,
    updatedAt: row.updated_at,
  };
}

export function runtimeConfigRevisionStorePath(): string {
  return CONFIG_REVISION_DB_PATH;
}

export function syncRuntimeConfigRevisionState(
  configPath: string,
  meta?: RuntimeConfigChangeMeta,
  observedFile?: RuntimeConfigObservedFile,
): { changed: boolean; previousMd5: string | null; currentMd5: string | null } {
  const normalizedMeta = normalizeChangeMeta(meta);
  const timestamp = new Date().toISOString();

  return withRevisionDatabase((database) => {
    return database
      .transaction(() => {
        const state = database
          .prepare<[string], ConfigRevisionTrackedStateRow>(
            `SELECT current_md5, current_content
             FROM config_revision_state
             WHERE config_path = ?`,
          )
          .get(configPath);

        const fileExists = observedFile?.exists ?? fs.existsSync(configPath);
        if (!fileExists) {
          if (!state) {
            return {
              changed: false,
              previousMd5: null,
              currentMd5: null,
            };
          }

          database
            .prepare(
              `INSERT INTO config_revisions (
                 config_path, actor, route, source, md5, byte_length, content, replaced_by_md5, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              configPath,
              normalizedMeta.actor,
              normalizedMeta.route,
              normalizedMeta.source,
              state.current_md5,
              Buffer.byteLength(state.current_content, 'utf-8'),
              state.current_content,
              null,
              timestamp,
            );
          database
            .prepare(`DELETE FROM config_revision_state WHERE config_path = ?`)
            .run(configPath);
          return {
            changed: true,
            previousMd5: state.current_md5,
            currentMd5: null,
          };
        }

        const content =
          observedFile?.content ?? fs.readFileSync(configPath, 'utf-8');
        const md5 = observedFile?.md5 ?? computeMd5(content);
        if (!state) {
          database
            .prepare(
              `INSERT INTO config_revision_state (
                 config_path, current_md5, current_content, actor, route, source, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              configPath,
              md5,
              content,
              normalizedMeta.actor,
              normalizedMeta.route,
              normalizedMeta.source,
              timestamp,
            );
          return {
            changed: false,
            previousMd5: null,
            currentMd5: md5,
          };
        }

        if (state.current_md5 === md5) {
          return {
            changed: false,
            previousMd5: state.current_md5,
            currentMd5: md5,
          };
        }

        database
          .prepare(
            `INSERT INTO config_revisions (
               config_path, actor, route, source, md5, byte_length, content, replaced_by_md5, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            configPath,
            normalizedMeta.actor,
            normalizedMeta.route,
            normalizedMeta.source,
            state.current_md5,
            Buffer.byteLength(state.current_content, 'utf-8'),
            state.current_content,
            md5,
            timestamp,
          );
        database
          .prepare(
            `UPDATE config_revision_state
             SET current_md5 = ?, current_content = ?, actor = ?, route = ?, source = ?, updated_at = ?
             WHERE config_path = ?`,
          )
          .run(
            md5,
            content,
            normalizedMeta.actor,
            normalizedMeta.route,
            normalizedMeta.source,
            timestamp,
            configPath,
          );
        return {
          changed: true,
          previousMd5: state.current_md5,
          currentMd5: md5,
        };
      })
      .immediate();
  });
}

export function listRuntimeConfigRevisions(
  configPath: string,
): RuntimeConfigRevisionSummary[] {
  return withRevisionDatabase((database) =>
    database
      .prepare<[string], ConfigRevisionSummaryRow>(
        `SELECT id, actor, route, source, md5, byte_length, created_at, replaced_by_md5
         FROM config_revisions
         WHERE config_path = ?
         ORDER BY id DESC`,
      )
      .all(configPath)
      .map((row) => mapRevisionSummaryRow(row)),
  );
}

export function getRuntimeConfigRevision(
  configPath: string,
  revisionId: number,
): RuntimeConfigRevision | null {
  return withRevisionDatabase((database) => {
    const row = database
      .prepare<[string, number], ConfigRevisionRow>(
        `SELECT id, actor, route, source, md5, byte_length, content, created_at, replaced_by_md5
         FROM config_revisions
         WHERE config_path = ? AND id = ?`,
      )
      .get(configPath, revisionId);
    return row ? mapRevisionRow(row) : null;
  });
}

export function getRuntimeConfigRevisionState(
  configPath: string,
): RuntimeConfigRevisionState | null {
  return withRevisionDatabase((database) => {
    const row = database
      .prepare<[string], ConfigRevisionStateRow>(
        `SELECT current_content, actor, route, source, updated_at
         FROM config_revision_state
         WHERE config_path = ?`,
      )
      .get(configPath);
    return row ? mapRevisionStateRow(row) : null;
  });
}

export function getRuntimeConfigRevisionStateMetadata(
  configPath: string,
): RuntimeConfigRevisionStateMetadata | null {
  return withRevisionDatabase((database) => {
    const row = database
      .prepare<[string], ConfigRevisionStateMetadataRow>(
        `SELECT actor, route, source, updated_at
         FROM config_revision_state
         WHERE config_path = ?`,
      )
      .get(configPath);
    return row ? mapRevisionStateMetadataRow(row) : null;
  });
}

export function deleteRuntimeConfigRevision(
  configPath: string,
  revisionId: number,
): boolean {
  return withRevisionDatabase((database) => {
    const result = database
      .prepare<[string, number]>(
        `DELETE FROM config_revisions WHERE config_path = ? AND id = ?`,
      )
      .run(configPath, revisionId);
    return result.changes > 0;
  });
}

export function clearRuntimeConfigRevisions(configPath: string): number {
  return withRevisionDatabase((database) => {
    const result = database
      .prepare<[string]>(`DELETE FROM config_revisions WHERE config_path = ?`)
      .run(configPath);
    return result.changes;
  });
}
