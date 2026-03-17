import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';

export interface ParsedSessionKey {
  agentId: string;
  channelKind: string;
  chatType: string;
  peerId: string;
  threadId?: string;
  topicId?: string;
  subagentId?: string;
}

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
const SESSION_KEY_MARKERS = new Set([
  'agent',
  'channel',
  'chat',
  'peer',
  'thread',
  'topic',
  'subagent',
]);

function normalizeSessionKeySegment(value: string, label: string): string {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (!normalized) {
    throw new Error(`Session key ${label} cannot be empty`);
  }
  return normalized;
}

function encodeSessionKeySegment(value: string, label: string): string {
  return encodeURIComponent(normalizeSessionKeySegment(value, label));
}

function decodeSessionKeySegment(value: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  try {
    return decodeURIComponent(normalized);
  } catch {
    return '';
  }
}

export function buildSessionKey(
  agentId: string,
  channelKind: string,
  chatType: string,
  peerId: string,
  options?: {
    threadId?: string;
    topicId?: string;
    subagentId?: string;
  },
): string {
  const parts = [
    'agent',
    encodeSessionKeySegment(agentId, 'agentId'),
    'channel',
    encodeSessionKeySegment(channelKind, 'channelKind'),
    'chat',
    encodeSessionKeySegment(chatType, 'chatType'),
    'peer',
    encodeSessionKeySegment(peerId, 'peerId'),
  ];

  if (options?.threadId) {
    parts.push('thread', encodeSessionKeySegment(options.threadId, 'threadId'));
  }
  if (options?.topicId) {
    parts.push('topic', encodeSessionKeySegment(options.topicId, 'topicId'));
  }
  if (options?.subagentId) {
    parts.push(
      'subagent',
      encodeSessionKeySegment(options.subagentId, 'subagentId'),
    );
  }

  return parts.join(':');
}

function parseTypedSessionKey(parts: string[]): ParsedSessionKey | null {
  if (parts.length < 8 || parts[0] !== 'agent') return null;

  const values = new Map<string, string>();
  for (let index = 0; index < parts.length; index += 2) {
    const marker = parts[index];
    const rawValue = parts[index + 1];
    if (!SESSION_KEY_MARKERS.has(marker) || rawValue === undefined) {
      return null;
    }
    if (values.has(marker)) return null;
    const decoded = decodeSessionKeySegment(rawValue);
    if (!decoded) return null;
    values.set(marker, decoded);
  }

  const agentId = values.get('agent');
  const channelKind = values.get('channel');
  const chatType = values.get('chat');
  const peerId = values.get('peer');
  if (!agentId || !channelKind || !chatType || !peerId) return null;

  return {
    agentId,
    channelKind,
    chatType,
    peerId,
    ...(values.get('thread') ? { threadId: values.get('thread') } : {}),
    ...(values.get('topic') ? { topicId: values.get('topic') } : {}),
    ...(values.get('subagent') ? { subagentId: values.get('subagent') } : {}),
  };
}

export function parseSessionKey(key: string): ParsedSessionKey | null {
  const parts = String(key || '')
    .trim()
    .split(':');
  if (parts.length < 5) return null;
  if (parts[0] !== 'agent') return null;
  if (parts[2] === 'channel') {
    return parseTypedSessionKey(parts);
  }

  // Keep positional canonical keys readable for pre-typed rows and exports.
  const [_, agentId, channelKind, chatType, ...peerParts] = parts;
  const peerId = peerParts.join(':').trim();
  if (!agentId || !channelKind || !chatType || !peerId) return null;
  return { agentId, channelKind, chatType, peerId };
}

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
