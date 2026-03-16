import {
  getAllSessions,
  getMemoryValue,
  getRecentMessages,
  getSessionById,
} from '../../memory/db.js';
import type { Session } from '../../types.js';
import type { DiscordToolActionRequest } from '../discord/tool-actions.js';
import {
  hasActiveMSTeamsSession,
  sendToActiveMSTeamsSession,
} from './runtime.js';
import {
  isRecord,
  MSTEAMS_CONVERSATION_REFERENCE_KEY,
  normalizeValue,
} from './utils.js';

const MESSAGE_TOOL_READ_DEFAULT_LIMIT = 20;
const MESSAGE_TOOL_READ_MAX_LIMIT = 100;
const MESSAGE_TOOL_TEAMS_CURRENT_PREFIX_RE = /^(?:msteams|teams):current$/i;
const MESSAGE_TOOL_TEAMS_SESSION_PREFIX_RE = /^teams:/i;

interface StoredMSTeamsReferenceUser {
  id: string;
  name: string | null;
}

interface StoredMSTeamsReferenceRecord {
  reference?: {
    user?: unknown;
  };
}

interface MSTeamsMemberLookupCandidate {
  id: string;
  name: string;
  lastSeenAt: string | null;
}

function isMSTeamsSessionId(value: string): boolean {
  return MESSAGE_TOOL_TEAMS_SESSION_PREFIX_RE.test(normalizeValue(value));
}

function looksLikeMSTeamsConversationId(value: string): boolean {
  const normalized = normalizeValue(value);
  return /^(?:a:|19:)/.test(normalized);
}

function normalizeMSTeamsMemberLookupQuery(
  rawValue: string | undefined,
): string {
  const trimmed = normalizeValue(rawValue);
  if (!trimmed) return '';
  const mentionMatch = trimmed.match(/^<at>([^<]+)<\/at>$/i);
  if (mentionMatch) {
    return normalizeValue(mentionMatch[1]);
  }
  return trimmed.replace(/^@+/, '').trim();
}

function resolveMessageToolReadLimit(limit: number | undefined): number {
  const requested =
    typeof limit === 'number' && Number.isFinite(limit)
      ? Math.floor(limit)
      : MESSAGE_TOOL_READ_DEFAULT_LIMIT;
  return Math.max(1, Math.min(MESSAGE_TOOL_READ_MAX_LIMIT, requested));
}

function normalizeStoredMessageTimestamp(raw: string): string {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    const parsed = Date.parse(`${value.replace(' ', 'T')}Z`);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
}

function isLikelyMSTeamsRequest(request: DiscordToolActionRequest): boolean {
  const sessionId = normalizeValue(request.sessionId);
  if (isMSTeamsSessionId(sessionId)) {
    return true;
  }

  const channelId = normalizeValue(request.channelId);
  if (!channelId) {
    return false;
  }
  return (
    MESSAGE_TOOL_TEAMS_CURRENT_PREFIX_RE.test(channelId) ||
    isMSTeamsSessionId(channelId) ||
    looksLikeMSTeamsConversationId(channelId)
  );
}

function pickMostRecentMatchingSession(
  request: DiscordToolActionRequest,
  channelId: string,
): Session | null {
  const normalizedGuildId = normalizeValue(request.guildId) || null;
  const matched = getAllSessions().filter(
    (session) =>
      isMSTeamsSessionId(session.id) &&
      normalizeValue(session.channel_id) === channelId &&
      (!normalizedGuildId ||
        normalizeValue(session.guild_id) === normalizedGuildId),
  );
  return matched[0] || null;
}

function resolveKnownMSTeamsSession(
  request: DiscordToolActionRequest,
): Session | null {
  const sessionId = normalizeValue(request.sessionId);
  const currentSession = isMSTeamsSessionId(sessionId)
    ? getSessionById(sessionId) || null
    : null;
  const rawChannelId = normalizeValue(request.channelId);

  if (
    !rawChannelId ||
    MESSAGE_TOOL_TEAMS_CURRENT_PREFIX_RE.test(rawChannelId)
  ) {
    return currentSession;
  }

  if (
    currentSession &&
    rawChannelId === normalizeValue(currentSession.channel_id)
  ) {
    return currentSession;
  }

  if (isMSTeamsSessionId(rawChannelId)) {
    const explicitSession = getSessionById(rawChannelId);
    return explicitSession && isMSTeamsSessionId(explicitSession.id)
      ? explicitSession
      : null;
  }

  if (looksLikeMSTeamsConversationId(rawChannelId) || currentSession) {
    return pickMostRecentMatchingSession(request, rawChannelId);
  }

  return null;
}

function ensureAuthorizedMSTeamsSendTarget(
  request: DiscordToolActionRequest,
  targetSession: Session,
): void {
  const requesterSessionId = normalizeValue(request.sessionId);
  if (!isMSTeamsSessionId(requesterSessionId)) {
    throw new Error(
      'Teams send is only allowed from the current Teams session.',
    );
  }
  if (requesterSessionId !== targetSession.id) {
    throw new Error(
      'Teams send is only allowed to the current Teams session. Cross-session proactive Teams sends are not authorized.',
    );
  }
}

function readStoredMSTeamsReferenceUser(
  sessionId: string,
): StoredMSTeamsReferenceUser | null {
  const stored = getMemoryValue(sessionId, MSTEAMS_CONVERSATION_REFERENCE_KEY);
  if (!isRecord(stored)) {
    return null;
  }
  const reference = isRecord((stored as StoredMSTeamsReferenceRecord).reference)
    ? (stored as StoredMSTeamsReferenceRecord).reference
    : null;
  const user = reference && isRecord(reference.user) ? reference.user : null;
  const id = user ? normalizeValue(user.id as string | undefined) : '';
  if (!id) {
    return null;
  }
  return {
    id,
    name: normalizeValue(user?.name as string | undefined) || null,
  };
}

function collectMSTeamsMemberCandidates(
  sessionId: string,
): MSTeamsMemberLookupCandidate[] {
  const candidates = new Map<string, MSTeamsMemberLookupCandidate>();
  const storedUser = readStoredMSTeamsReferenceUser(sessionId);
  if (storedUser) {
    candidates.set(storedUser.id, {
      id: storedUser.id,
      name: storedUser.name || storedUser.id,
      lastSeenAt: null,
    });
  }

  for (const message of getRecentMessages(
    sessionId,
    MESSAGE_TOOL_READ_MAX_LIMIT,
  )) {
    if (message.role === 'assistant') continue;
    const userId = normalizeValue(message.user_id);
    if (!userId) continue;
    const existing = candidates.get(userId);
    const candidate: MSTeamsMemberLookupCandidate = {
      id: userId,
      name: normalizeValue(message.username || '') || userId,
      lastSeenAt: normalizeStoredMessageTimestamp(message.created_at) || null,
    };
    if (!existing) {
      candidates.set(userId, candidate);
      continue;
    }
    if (!existing.name && candidate.name) {
      existing.name = candidate.name;
    }
    if (!existing.lastSeenAt && candidate.lastSeenAt) {
      existing.lastSeenAt = candidate.lastSeenAt;
    }
  }

  return [...candidates.values()].sort(
    (a, b) =>
      (b.lastSeenAt || '').localeCompare(a.lastSeenAt || '') ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );
}

function resolveMSTeamsMemberCandidate(
  candidates: MSTeamsMemberLookupCandidate[],
  rawQuery: string,
  resolveAmbiguous: 'error' | 'best' = 'error',
):
  | {
      ok: true;
      candidate: MSTeamsMemberLookupCandidate;
      note?: string;
      candidates?: MSTeamsMemberLookupCandidate[];
    }
  | { ok: false; error: string; candidates?: MSTeamsMemberLookupCandidate[] } {
  const query = normalizeMSTeamsMemberLookupQuery(rawQuery);
  if (!query) {
    if (candidates.length === 1) {
      return { ok: true, candidate: candidates[0] };
    }
    return {
      ok: false,
      error:
        'userId or user is required for Teams member-info unless the current Teams conversation only has one known non-assistant participant.',
      ...(candidates.length > 0 ? { candidates: candidates.slice(0, 10) } : {}),
    };
  }

  const exactId = candidates.find((candidate) => candidate.id === query);
  if (exactId) {
    return { ok: true, candidate: exactId };
  }

  const loweredQuery = query.toLowerCase();
  const matched = candidates.filter((candidate) => {
    const loweredName = candidate.name.toLowerCase();
    return (
      loweredName === loweredQuery ||
      loweredName.includes(loweredQuery) ||
      candidate.id.toLowerCase().includes(loweredQuery)
    );
  });

  if (matched.length === 0) {
    return {
      ok: false,
      error: `No Teams participant matched "${query}" in the known conversation history.`,
    };
  }
  if (matched.length === 1) {
    return { ok: true, candidate: matched[0] };
  }
  if (resolveAmbiguous === 'best') {
    const best = matched[0];
    const others = matched
      .slice(1, 10)
      .map((candidate) => `${candidate.name} (${candidate.id})`)
      .join(', ');
    return {
      ok: true,
      candidate: best,
      note: `Resolved ambiguous Teams participant match to: ${best.name}. Other candidates: ${others || 'none'}.`,
      candidates: matched.slice(0, 10),
    };
  }
  return {
    ok: false,
    error: `Ambiguous Teams participant match for "${query}". Provide the Teams user ID or a more specific display name.`,
    candidates: matched.slice(0, 10),
  };
}

async function runMSTeamsSendAction(
  request: DiscordToolActionRequest,
  targetSession: Session,
  resolvedFilePath: string | null,
): Promise<Record<string, unknown>> {
  ensureAuthorizedMSTeamsSendTarget(request, targetSession);
  const content = String(request.content || '').trim();
  if (!content && !resolvedFilePath) {
    throw new Error(
      'content is required for Teams send unless filePath is provided.',
    );
  }
  if (
    Array.isArray(request.components) ||
    (request.components !== null && typeof request.components === 'object')
  ) {
    throw new Error('components are not supported for Teams sends.');
  }

  const delivery = await sendToActiveMSTeamsSession({
    sessionId: targetSession.id,
    text: content,
    filePath: resolvedFilePath,
  });
  return {
    ok: true,
    action: 'send',
    channelId: delivery.channelId || targetSession.channel_id,
    sessionId: targetSession.id,
    transport: 'msteams',
    ...(delivery.attachmentCount > 0
      ? { attachmentCount: delivery.attachmentCount }
      : {}),
    contentLength: content.length,
  };
}

function runMSTeamsReadAction(
  request: DiscordToolActionRequest,
  targetSession: Session,
): Record<string, unknown> {
  if (
    normalizeValue(request.before) ||
    normalizeValue(request.after) ||
    normalizeValue(request.around)
  ) {
    throw new Error(
      'before, after, and around are not supported for Teams reads.',
    );
  }

  const limit = resolveMessageToolReadLimit(request.limit);
  const messages = getRecentMessages(targetSession.id, limit).map((message) => {
    const isAssistant = message.role === 'assistant';
    return {
      id: message.id,
      sessionId: message.session_id,
      channelId: targetSession.channel_id,
      content: message.content,
      createdAt: normalizeStoredMessageTimestamp(message.created_at),
      role: message.role,
      author: {
        id: message.user_id,
        username: message.username || message.user_id,
        assistant: isAssistant,
      },
    };
  });

  return {
    ok: true,
    action: 'read',
    channelId: targetSession.channel_id,
    sessionId: targetSession.id,
    transport: 'msteams',
    count: messages.length,
    messages,
  };
}

function runMSTeamsChannelInfoAction(
  targetSession: Session,
): Record<string, unknown> {
  return {
    ok: true,
    action: 'channel-info',
    transport: 'msteams',
    channel: {
      id: targetSession.channel_id,
      sessionId: targetSession.id,
      teamId: targetSession.guild_id,
      isDm: targetSession.id.startsWith('teams:dm:'),
      active: hasActiveMSTeamsSession(targetSession.id),
      proactiveAvailable: Boolean(
        getMemoryValue(targetSession.id, MSTEAMS_CONVERSATION_REFERENCE_KEY),
      ),
      createdAt: targetSession.created_at,
      lastActive: targetSession.last_active,
    },
  };
}

function runMSTeamsMemberInfoAction(
  request: DiscordToolActionRequest,
  targetSession: Session,
): Record<string, unknown> {
  const candidates = collectMSTeamsMemberCandidates(targetSession.id);
  const lookup = resolveMSTeamsMemberCandidate(
    candidates,
    request.userId ||
      request.memberId ||
      request.user ||
      request.username ||
      '',
    request.resolveAmbiguous,
  );
  if (!lookup.ok) {
    return {
      ok: false,
      action: 'member-info',
      channelId: targetSession.channel_id,
      sessionId: targetSession.id,
      transport: 'msteams',
      error: lookup.error,
      ...(lookup.candidates ? { candidates: lookup.candidates } : {}),
    };
  }

  return {
    ok: true,
    action: 'member-info',
    channelId: targetSession.channel_id,
    sessionId: targetSession.id,
    transport: 'msteams',
    userId: lookup.candidate.id,
    ...(lookup.note ? { note: lookup.note } : {}),
    ...(lookup.candidates ? { candidates: lookup.candidates } : {}),
    member: {
      id: lookup.candidate.id,
      displayName: lookup.candidate.name,
      handle: lookup.candidate.name ? `@${lookup.candidate.name}` : null,
      lastSeenAt: lookup.candidate.lastSeenAt,
    },
  };
}

export async function maybeRunMSTeamsToolAction(
  request: DiscordToolActionRequest,
  params: {
    resolveSendFilePath: (request: DiscordToolActionRequest) => string | null;
  },
): Promise<Record<string, unknown> | null> {
  if (!isLikelyMSTeamsRequest(request)) {
    return null;
  }

  const targetSession = resolveKnownMSTeamsSession(request);
  if (!targetSession) {
    throw new Error(
      'No known Teams conversation matched this request. Use the current Teams chat, a known Teams conversation ID, or a Teams session ID.',
    );
  }

  switch (request.action) {
    case 'send':
      return await runMSTeamsSendAction(
        request,
        targetSession,
        params.resolveSendFilePath(request),
      );
    case 'read':
      return runMSTeamsReadAction(request, targetSession);
    case 'channel-info':
      return runMSTeamsChannelInfoAction(targetSession);
    case 'member-info':
      return runMSTeamsMemberInfoAction(request, targetSession);
    default:
      return null;
  }
}
