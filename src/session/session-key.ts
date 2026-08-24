import {
  buildSessionKey,
  parseSessionKey,
} from '../../container/shared/session-keys.js';
import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';

export type { ParsedSessionKey } from '../../container/shared/session-keys.js';
export { buildSessionKey, parseSessionKey };

export interface SessionKeyMigrationResult {
  key: string;
  migrated: boolean;
}

export type SessionKeyShape =
  | 'empty'
  | 'canonical'
  | 'canonical_malformed'
  | 'legacy'
  | 'opaque';

interface SessionKeyMigrationContext {
  agent_id?: string | null;
  guild_id?: string | null;
  channel_id?: string | null;
}

const DISCORD_SESSION_KEY_RE = /^\d{16,22}:\d{16,22}$/;

export function classifySessionKeyShape(key: string): SessionKeyShape {
  const normalized = String(key || '').trim();
  if (!normalized) return 'empty';
  if (parseSessionKey(normalized)) return 'canonical';
  if (normalized.startsWith('agent:')) return 'canonical_malformed';
  if (
    DISCORD_SESSION_KEY_RE.test(normalized) ||
    normalized.startsWith('cron:') ||
    normalized.startsWith('dm:') ||
    normalized.startsWith('heartbeat:') ||
    normalized.startsWith('scheduler:') ||
    normalized.startsWith('tui:')
  ) {
    return 'legacy';
  }
  return 'opaque';
}

export function isLegacySessionKey(key: string): boolean {
  return classifySessionKeyShape(key) === 'legacy';
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
  if (classifySessionKeyShape(normalized) === 'canonical') {
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
