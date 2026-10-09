/**
 * Channel user registry: senders observed on a chat channel, keyed by
 * (channel kind, tenant, external user id) — the key `usage_events` records,
 * so per-user usage joins without a second identity map. Usage belongs to the
 * initiating user, even in shared chats. Opaque user IDs retain their case;
 * tenants are lowercased as in the usage ledger. Channel-specific identifiers
 * live in `profile`. This store records who was seen and which agent an
 * administrator assigned; it never grants channel access.
 */
import type { ChannelKind } from '../channels/channel.js';
import { withMemoryDatabase } from './database.js';

export interface ChannelUserKey {
  channelKind: ChannelKind;
  tenantId: string;
  userId: string;
}

export interface ChannelUser {
  tenantId: string;
  userId: string;
  displayName: string | null;
  agentId: string | null;
  profile: Record<string, string>;
  messageCount: number;
  firstSeen: string;
  lastSeen: string;
  sessionCount: number;
  totalTokens: number;
  costUsd: number;
}

function keyParams(key: ChannelUserKey): [string, string, string] {
  return [
    key.channelKind,
    key.tenantId.trim().toLowerCase(),
    key.userId.trim(),
  ];
}

export function observeChannelUser(
  params: ChannelUserKey & {
    displayName?: string | null;
    email?: string | null;
    profile?: Record<string, string | null | undefined>;
    isMessage: boolean;
  },
): void {
  const profile = Object.fromEntries(
    Object.entries(params.profile ?? {}).flatMap(([name, value]) =>
      value?.trim() ? [[name, value.trim()]] : [],
    ),
  );
  withMemoryDatabase((db) => {
    db.prepare(`INSERT INTO channel_users
      (channel_kind, tenant_id, user_id, display_name, email, profile_json, message_count)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(channel_kind, tenant_id, user_id) DO UPDATE SET
        display_name = COALESCE(excluded.display_name, display_name),
        email = COALESCE(excluded.email, email),
        profile_json = json_patch(profile_json, excluded.profile_json),
        message_count = message_count + excluded.message_count,
        last_seen = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`).run(
      ...keyParams(params),
      params.displayName?.trim() || null,
      params.email?.trim() || null,
      JSON.stringify(profile),
      params.isMessage ? 1 : 0,
    );
  });
}

/** Mapping state of an observed sender; null when the sender was never seen. */
export function getChannelUserMapping(
  key: ChannelUserKey,
): { agentId: string | null } | null {
  return withMemoryDatabase((db) => {
    const row = db
      .prepare(
        'SELECT agent_id FROM channel_users WHERE channel_kind = ? AND tenant_id = ? AND user_id = ?',
      )
      .get(...keyParams(key)) as { agent_id: string | null } | undefined;
    return row ? { agentId: row.agent_id ?? null } : null;
  });
}

/** Latest known email of a sender, across tenants of one channel. */
export function findChannelUserEmail(
  channelKind: ChannelKind,
  userId: string,
): string | null {
  return withMemoryDatabase((db) => {
    const row = db
      .prepare(
        'SELECT email FROM channel_users WHERE channel_kind = ? AND user_id = ? AND email IS NOT NULL ORDER BY last_seen DESC LIMIT 1',
      )
      .get(channelKind, userId.trim()) as { email: string } | undefined;
    return row?.email ?? null;
  });
}

export function setChannelUserAgent(
  key: ChannelUserKey,
  agentId: string | null,
): boolean {
  return withMemoryDatabase(
    (db) =>
      db
        .prepare(
          'UPDATE channel_users SET agent_id = ? WHERE channel_kind = ? AND tenant_id = ? AND user_id = ?',
        )
        .run(agentId, ...keyParams(key)).changes > 0,
  );
}

export function listChannelUsers(
  channelKind: ChannelKind,
  tenantId: string,
): ChannelUser[] {
  const tenant = tenantId.trim().toLowerCase();
  const rows = withMemoryDatabase(
    (db) =>
      db
        .prepare(`
    WITH usage AS (
      SELECT user_id, COUNT(DISTINCT session_id) AS sessions,
        SUM(total_tokens) AS tokens, SUM(cost_usd) AS cost
      FROM usage_events WHERE channel_kind = ? AND tenant_id = ?
      GROUP BY user_id
    )
    SELECT u.tenant_id AS tenantId, u.user_id AS userId,
      u.display_name AS displayName, u.agent_id AS agentId,
      u.profile_json AS profileJson,
      u.message_count AS messageCount, u.first_seen AS firstSeen,
      u.last_seen AS lastSeen, COALESCE(usage.sessions, 0) AS sessionCount,
      COALESCE(usage.tokens, 0) AS totalTokens, COALESCE(usage.cost, 0) AS costUsd
    FROM channel_users u LEFT JOIN usage ON usage.user_id = u.user_id
    WHERE u.channel_kind = ? AND u.tenant_id = ?
    ORDER BY u.last_seen DESC, u.user_id
  `)
        .all(channelKind, tenant, channelKind, tenant) as Array<
        Omit<ChannelUser, 'profile'> & { profileJson: string }
      >,
  );
  return rows.map(({ profileJson, ...user }) => ({
    ...user,
    profile: JSON.parse(profileJson) as Record<string, string>,
  }));
}
