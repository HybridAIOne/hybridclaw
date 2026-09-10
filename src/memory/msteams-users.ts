/**
 * Teams sender registry: tenant-scoped identities and administrator routing choices.
 * Usage belongs to the initiating user, even in shared chats; session totals are
 * never assigned to every participant. Opaque user IDs retain their case.
 * This store does not grant Teams access.
 */
import { withMemoryDatabase } from './database.js';

export interface MSTeamsUser {
  tenantId: string;
  userId: string;
  teamsUserId: string | null;
  entraObjectId: string | null;
  displayName: string | null;
  agentId: string | null;
  messageCount: number;
  firstSeen: string;
  lastSeen: string;
  sessionCount: number;
  totalTokens: number;
  costUsd: number;
}

export function observeMSTeamsUser(params: {
  tenantId: string;
  userId: string;
  teamsUserId?: string | null;
  entraObjectId?: string | null;
  displayName?: string | null;
  isMessage: boolean;
}): void {
  withMemoryDatabase((db) => {
    db.prepare(`INSERT INTO msteams_users
      (tenant_id, user_id, teams_user_id, entra_object_id, display_name, message_count)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, user_id) DO UPDATE SET
        teams_user_id = COALESCE(excluded.teams_user_id, teams_user_id),
        entra_object_id = COALESCE(excluded.entra_object_id, entra_object_id),
        display_name = COALESCE(excluded.display_name, display_name),
        message_count = message_count + excluded.message_count,
        last_seen = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`).run(
      params.tenantId.trim().toLowerCase(),
      params.userId.trim(),
      params.teamsUserId?.trim() || null,
      params.entraObjectId?.trim().toLowerCase() || null,
      params.displayName?.trim() || null,
      params.isMessage ? 1 : 0,
    );
  });
}

export function getMSTeamsUserAgent(
  tenantId: string,
  userId: string,
): string | null {
  return withMemoryDatabase((db) => {
    const row = db
      .prepare(
        'SELECT agent_id FROM msteams_users WHERE tenant_id = ? AND user_id = ?',
      )
      .get(tenantId.trim().toLowerCase(), userId.trim()) as
      | { agent_id: string | null }
      | undefined;
    return row?.agent_id ?? null;
  });
}

export function setMSTeamsUserAgent(
  tenantId: string,
  userId: string,
  agentId: string | null,
): boolean {
  return withMemoryDatabase(
    (db) =>
      db
        .prepare(
          'UPDATE msteams_users SET agent_id = ? WHERE tenant_id = ? AND user_id = ?',
        )
        .run(agentId, tenantId.trim().toLowerCase(), userId.trim()).changes > 0,
  );
}

export function listMSTeamsUsers(tenantId: string): MSTeamsUser[] {
  return withMemoryDatabase(
    (db) =>
      db
        .prepare(`
    WITH usage AS (
      SELECT user_id, COUNT(DISTINCT session_id) AS sessions,
        SUM(total_tokens) AS tokens, SUM(cost_usd) AS cost
      FROM usage_events WHERE channel_kind = 'msteams' AND tenant_id = ?
      GROUP BY user_id
    )
    SELECT u.tenant_id AS tenantId, u.user_id AS userId,
      u.teams_user_id AS teamsUserId, u.entra_object_id AS entraObjectId,
      u.display_name AS displayName, u.agent_id AS agentId,
      u.message_count AS messageCount, u.first_seen AS firstSeen,
      u.last_seen AS lastSeen, COALESCE(usage.sessions, 0) AS sessionCount,
      COALESCE(usage.tokens, 0) AS totalTokens, COALESCE(usage.cost, 0) AS costUsd
    FROM msteams_users u LEFT JOIN usage ON usage.user_id = u.user_id
    WHERE u.tenant_id = ? ORDER BY u.last_seen DESC, u.user_id
  `)
        .all(
          tenantId.trim().toLowerCase(),
          tenantId.trim().toLowerCase(),
        ) as MSTeamsUser[],
  );
}
