import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';

export interface ParsedSessionKey {
  agentId: string;
  channelKind: string;
  chatType: string;
  peerId: string;
}

export interface SessionKeyMigrationResult {
  key: string;
  migrated: boolean;
}

interface SessionKeyMigrationContext {
  agent_id?: string | null;
  guild_id?: string | null;
  channel_id?: string | null;
}

const DISCORD_SESSION_KEY_RE = /^\d{16,22}:\d{16,22}$/;

function normalizeSessionKeySegment(value: string, label: string): string {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (!normalized) {
    throw new Error(`Session key ${label} cannot be empty`);
  }
  return normalized;
}

export function buildSessionKey(
  agentId: string,
  channelKind: string,
  chatType: string,
  peerId: string,
): string {
  return [
    'agent',
    normalizeSessionKeySegment(agentId, 'agentId'),
    normalizeSessionKeySegment(channelKind, 'channelKind'),
    normalizeSessionKeySegment(chatType, 'chatType'),
    normalizeSessionKeySegment(peerId, 'peerId'),
  ].join(':');
}

export function parseSessionKey(key: string): ParsedSessionKey | null {
  const parts = String(key || '')
    .trim()
    .split(':');
  if (parts.length < 5) return null;
  if (parts[0] !== 'agent') return null;
  const [_, agentId, channelKind, chatType, ...peerParts] = parts;
  const peerId = peerParts.join(':').trim();
  if (!agentId || !channelKind || !chatType || !peerId) return null;
  return {
    agentId,
    channelKind,
    chatType,
    peerId,
  };
}

export function isLegacySessionKey(key: string): boolean {
  const normalized = String(key || '').trim();
  if (!normalized) return false;
  if (parseSessionKey(normalized)) return false;
  return (
    DISCORD_SESSION_KEY_RE.test(normalized) ||
    normalized.startsWith('cron:') ||
    normalized.startsWith('dm:') ||
    normalized.startsWith('heartbeat:') ||
    normalized.startsWith('scheduler:') ||
    normalized.startsWith('tui:')
  );
}

export function migrateLegacySessionKey(
  key: string,
  session: SessionKeyMigrationContext,
): string {
  return inspectSessionKeyMigration(key, session).key;
}

export function inspectSessionKeyMigration(
  key: string,
  session: SessionKeyMigrationContext,
): SessionKeyMigrationResult {
  const normalized = String(key || '').trim();
  if (!normalized) return { key: normalized, migrated: false };
  if (parseSessionKey(normalized)) {
    return { key: normalized, migrated: false };
  }

  const normalizedAgentId =
    String(session.agent_id || '').trim() || DEFAULT_AGENT_ID;
  const discordMatch = normalized.match(/^(\d{16,22}):(\d{16,22})$/);
  if (discordMatch) {
    const channelId = String(session.channel_id || discordMatch[2]).trim();
    return {
      key: buildSessionKey(normalizedAgentId, 'discord', 'channel', channelId),
      migrated: true,
    };
  }

  if (normalized.startsWith('dm:')) {
    return {
      key: buildSessionKey(
        normalizedAgentId,
        'discord',
        'dm',
        normalized.slice('dm:'.length),
      ),
      migrated: true,
    };
  }

  if (normalized.startsWith('heartbeat:')) {
    const agentIdFromKey =
      normalized.slice('heartbeat:'.length).trim() || normalizedAgentId;
    return {
      key: buildSessionKey(agentIdFromKey, 'heartbeat', 'system', 'default'),
      migrated: true,
    };
  }

  if (normalized.startsWith('scheduler:')) {
    return {
      key: buildSessionKey(
        normalizedAgentId,
        'scheduler',
        'system',
        normalized.slice('scheduler:'.length),
      ),
      migrated: true,
    };
  }

  if (normalized.startsWith('cron:')) {
    return {
      key: buildSessionKey(
        normalizedAgentId,
        'scheduler',
        'cron',
        normalized.slice('cron:'.length),
      ),
      migrated: true,
    };
  }

  if (normalized.startsWith('tui:')) {
    return {
      key: buildSessionKey(
        normalizedAgentId,
        'tui',
        'dm',
        normalized.slice('tui:'.length),
      ),
      migrated: true,
    };
  }

  // Unknown or non-legacy inputs pass through unchanged; callers can use the
  // explicit `migrated` flag to distinguish this no-op from a real rewrite.
  return { key: normalized, migrated: false };
}
