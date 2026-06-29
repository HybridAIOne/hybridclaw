import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { withMemoryDatabase } from './db.js';

/**
 * Slugs for the artifact/app categories surfaced in the gallery "New App"
 * picker. `scratch` ("Von Grund auf neu beginnen") is the freeform option.
 */
export const APP_CATEGORIES = [
  'apps',
  'documents',
  'games',
  'productivity',
  'creative',
  'quiz',
  'scratch',
] as const;

export type AppCategory = (typeof APP_CATEGORIES)[number];

export type AppVisibility = 'private' | 'public';

export interface StoredApp {
  id: string;
  title: string;
  description: string | null;
  category: AppCategory;
  html: string;
  prompt: string | null;
  agentId: string | null;
  sessionId: string | null;
  visibility: AppVisibility;
  createdAt: string;
  updatedAt: string;
}

/** Gallery list rows omit the (potentially large) HTML body. */
export type AppSummary = Omit<StoredApp, 'html'>;

export interface CreateAppInput {
  title: string;
  html: string;
  description?: string | null;
  category?: string | null;
  prompt?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
  visibility?: AppVisibility;
}

interface AppRow {
  id: string;
  title: string;
  description: string | null;
  category: string;
  html: string;
  prompt: string | null;
  agent_id: string | null;
  session_id: string | null;
  visibility: string;
  created_at: string;
  updated_at: string;
}

const SUMMARY_COLUMNS = `id, title, description, category, prompt, agent_id, session_id, visibility, created_at, updated_at`;

export function normalizeAppCategory(
  raw: string | null | undefined,
): AppCategory {
  const value = String(raw || '')
    .trim()
    .toLowerCase();
  return (APP_CATEGORIES as readonly string[]).includes(value)
    ? (value as AppCategory)
    : 'apps';
}

function normalizeVisibility(raw: string | null | undefined): AppVisibility {
  return raw === 'public' ? 'public' : 'private';
}

function appSummaryFromRow(row: Omit<AppRow, 'html'>): AppSummary {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: normalizeAppCategory(row.category),
    prompt: row.prompt,
    agentId: row.agent_id,
    sessionId: row.session_id,
    visibility: normalizeVisibility(row.visibility),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function appFromRow(row: AppRow): StoredApp {
  return {
    ...appSummaryFromRow(row),
    html: row.html,
  };
}

export function createApp(input: CreateAppInput): StoredApp {
  return withMemoryDatabase((database: Database.Database) => {
    const id = randomUUID();
    const category = normalizeAppCategory(input.category);
    const visibility = normalizeVisibility(input.visibility);
    database
      .prepare(
        `INSERT INTO apps
          (id, title, description, category, html, prompt, agent_id, session_id, visibility, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
      )
      .run(
        id,
        input.title.trim() || 'Untitled App',
        input.description?.trim() || null,
        category,
        input.html,
        input.prompt?.trim() || null,
        input.agentId?.trim() || null,
        input.sessionId?.trim() || null,
        visibility,
      );
    const row = database
      .prepare<unknown[], AppRow>(`SELECT * FROM apps WHERE id = ?`)
      .get(id);
    if (!row) {
      throw new Error('Failed to persist generated app.');
    }
    return appFromRow(row);
  });
}

export interface ListAppsQuery {
  category?: string;
  search?: string;
  limit?: number;
}

export function listApps(query: ListAppsQuery = {}): AppSummary[] {
  return withMemoryDatabase((database: Database.Database) => {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (query.category && query.category !== 'all') {
      clauses.push('category = ?');
      params.push(normalizeAppCategory(query.category));
    }
    const search = query.search?.trim().toLowerCase();
    if (search) {
      clauses.push('(LOWER(title) LIKE ? OR LOWER(description) LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit =
      typeof query.limit === 'number' && Number.isFinite(query.limit)
        ? Math.min(Math.max(Math.floor(query.limit), 1), 500)
        : 200;
    const rows = database
      .prepare<unknown[], Omit<AppRow, 'html'>>(
        `SELECT ${SUMMARY_COLUMNS} FROM apps ${where} ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...params, limit);
    return rows.map(appSummaryFromRow);
  });
}

export interface UpsertAppForSessionInput {
  title: string;
  html: string;
  category?: string | null;
  description?: string | null;
  prompt?: string | null;
  agentId?: string | null;
}

/**
 * Create or update the app attached to a chat session. App-build conversations
 * call this on each turn that produces HTML, so the gallery entry evolves with
 * the conversation instead of creating duplicates.
 */
export function upsertAppForSession(
  sessionId: string,
  input: UpsertAppForSessionInput,
): StoredApp {
  return withMemoryDatabase((database: Database.Database) => {
    const session = sessionId.trim();
    const category = normalizeAppCategory(input.category);
    const title = input.title.trim() || 'Untitled App';
    const existing = session
      ? (database
          .prepare<unknown[], { id: string }>(
            `SELECT id FROM apps WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`,
          )
          .get(session) ?? null)
      : null;
    if (existing) {
      database
        .prepare(
          `UPDATE apps
             SET title = ?, html = ?, category = ?,
                 description = COALESCE(?, description),
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE id = ?`,
        )
        .run(
          title,
          input.html,
          category,
          input.description?.trim() || null,
          existing.id,
        );
      const row = database
        .prepare<unknown[], AppRow>(`SELECT * FROM apps WHERE id = ?`)
        .get(existing.id);
      if (!row) throw new Error('Failed to update app for session.');
      return appFromRow(row);
    }
    return createApp({
      title,
      html: input.html,
      category,
      description: input.description ?? null,
      prompt: input.prompt ?? null,
      agentId: input.agentId ?? null,
      sessionId: session || null,
    });
  });
}

export function getApp(id: string): StoredApp | null {
  return withMemoryDatabase((database: Database.Database) => {
    const normalized = id.trim();
    if (!normalized) return null;
    const row = database
      .prepare<unknown[], AppRow>(`SELECT * FROM apps WHERE id = ?`)
      .get(normalized);
    return row ? appFromRow(row) : null;
  });
}

export function deleteApp(id: string): boolean {
  return withMemoryDatabase((database: Database.Database) => {
    const normalized = id.trim();
    if (!normalized) return false;
    const result = database
      .prepare(`DELETE FROM apps WHERE id = ?`)
      .run(normalized);
    return result.changes > 0;
  });
}

export function countApps(): number {
  return withMemoryDatabase((database: Database.Database) => {
    const row = database
      .prepare<unknown[], { count: number }>(
        `SELECT COUNT(*) AS count FROM apps`,
      )
      .get();
    return row?.count ?? 0;
  });
}
