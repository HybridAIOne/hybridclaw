import {
  getAllSessions,
  getRecentMessages,
  getSessionById,
} from '../../memory/db.js';
import { parseSessionKey } from '../../session/session-key.js';
import type { Session } from '../../types/session.js';
import { normalizeTrimmedString as normalizeValue } from '../../utils/normalized-strings.js';
import type { DiscordToolActionRequest } from '../discord/tool-actions.js';
import { isSlackSessionId } from './inbound.js';
import { hasActiveSlackSession, sendToActiveSlackSession } from './runtime.js';
import { normalizeSlackUserId, parseSlackChannelTarget } from './target.js';

const MESSAGE_TOOL_SLACK_CURRENT_RE = /^slack:current$/i;
const MESSAGE_TOOL_READ_DEFAULT_LIMIT = 20;
const MESSAGE_TOOL_READ_MAX_LIMIT = 100;

interface SlackMemberLookupCandidate {
  id: string;
  name: string;
  lastSeenAt: string | null;
}

function isLikelySlackRequest(request: DiscordToolActionRequest): boolean {
  const sessionId = normalizeValue(request.sessionId);
  if (isSlackSessionId(sessionId)) {
    return true;
  }

  const channelId = normalizeValue(request.channelId);
  if (!channelId) return false;
  return (
    MESSAGE_TOOL_SLACK_CURRENT_RE.test(channelId) ||
    parseSlackChannelTarget(channelId) !== null
  );
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

function resolveReadLimit(limit: number | undefined): number {
  const requested =
    typeof limit === 'number' && Number.isFinite(limit)
      ? Math.floor(limit)
      : MESSAGE_TOOL_READ_DEFAULT_LIMIT;
  return Math.max(1, Math.min(MESSAGE_TOOL_READ_MAX_LIMIT, requested));
}

function pickMostRecentMatchingSession(
  target: string,
  guildId?: string,
): Session | null {
  const normalizedGuildId = normalizeValue(guildId) || null;
  const matched = getAllSessions().filter(
    (session) =>
      isSlackSessionId(session.id) &&
      normalizeValue(session.channel_id) === target &&
      (!normalizedGuildId ||
        normalizeValue(session.guild_id) === normalizedGuildId),
  );
  return matched[0] || null;
}

function resolveKnownSlackSession(
  request: DiscordToolActionRequest,
): Session | null {
  const sessionId = normalizeValue(request.sessionId);
  const currentSession = isSlackSessionId(sessionId)
    ? getSessionById(sessionId) || null
    : null;
  const rawChannelId = normalizeValue(request.channelId);

  if (!rawChannelId || MESSAGE_TOOL_SLACK_CURRENT_RE.test(rawChannelId)) {
    return currentSession;
  }

  const parsedTarget = parseSlackChannelTarget(rawChannelId);
  if (!parsedTarget) {
    return currentSession;
  }
  if (
    currentSession &&
    normalizeValue(currentSession.channel_id) === parsedTarget.target
  ) {
    return currentSession;
  }

  return pickMostRecentMatchingSession(parsedTarget.target, request.guildId);
}

function ensureAuthorizedSlackSendTarget(
  request: DiscordToolActionRequest,
  targetSession: Session,
): void {
  const requesterSessionId = normalizeValue(request.sessionId);
  if (!isSlackSessionId(requesterSessionId)) {
    throw new Error(
      'Slack send is only allowed from the current active Slack session.',
    );
  }
  if (requesterSessionId !== targetSession.id) {
    throw new Error(
      'Slack send is only allowed to the current active Slack session.',
    );
  }
}

function collectSlackMemberCandidates(
  sessionId: string,
): SlackMemberLookupCandidate[] {
  const candidates = new Map<string, SlackMemberLookupCandidate>();
  for (const message of getRecentMessages(
    sessionId,
    MESSAGE_TOOL_READ_MAX_LIMIT,
  )) {
    if (message.role === 'assistant') continue;
    const userId = normalizeSlackUserId(message.user_id);
    if (!userId) continue;
    const candidate: SlackMemberLookupCandidate = {
      id: userId,
      name: normalizeValue(message.username) || userId,
      lastSeenAt: normalizeStoredMessageTimestamp(message.created_at) || null,
    };
    const existing = candidates.get(userId);
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

function resolveSlackMemberLookup(
  candidates: SlackMemberLookupCandidate[],
  rawQuery: string,
  resolveAmbiguous: 'error' | 'best' = 'error',
):
  | {
      ok: true;
      candidate: SlackMemberLookupCandidate;
      note?: string;
      candidates?: SlackMemberLookupCandidate[];
    }
  | { ok: false; error: string; candidates?: SlackMemberLookupCandidate[] } {
  const normalizedId = normalizeSlackUserId(rawQuery);
  const query = normalizedId || normalizeValue(rawQuery).replace(/^@+/, '');
  if (!query) {
    if (candidates.length === 1) {
      return { ok: true, candidate: candidates[0] };
    }
    return {
      ok: false,
      error:
        'userId or user is required for Slack member-info unless the current Slack session only has one known non-assistant participant.',
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
      error: `No Slack participant matched "${query}" in the known session history.`,
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
      note: `Resolved ambiguous Slack participant match to: ${best.name}. Other candidates: ${others || 'none'}.`,
      candidates: matched.slice(0, 10),
    };
  }

  return {
    ok: false,
    error: `Ambiguous Slack participant match for "${query}". Provide the Slack user ID or a more specific display name.`,
    candidates: matched.slice(0, 10),
  };
}

async function runSlackSendAction(
  request: DiscordToolActionRequest,
  targetSession: Session,
  resolvedFilePath: string | null,
): Promise<Record<string, unknown>> {
  ensureAuthorizedSlackSendTarget(request, targetSession);
  const content = normalizeValue(request.content);
  if (!content && !resolvedFilePath) {
    throw new Error(
      'content is required for Slack send unless filePath is provided.',
    );
  }
  if (
    Array.isArray(request.components) ||
    (request.components !== null && typeof request.components === 'object')
  ) {
    throw new Error('components are not supported for Slack sends.');
  }

  const delivery = await sendToActiveSlackSession({
    sessionId: targetSession.id,
    text: resolvedFilePath ? '' : content,
    filePath: resolvedFilePath,
    filename: request.name,
    caption: resolvedFilePath ? content || null : null,
  });
  return {
    ok: true,
    action: 'send',
    channelId: delivery.channelId || targetSession.channel_id,
    sessionId: targetSession.id,
    transport: 'slack',
    ...(delivery.attachmentCount > 0
      ? { attachmentCount: delivery.attachmentCount }
      : {}),
    contentLength: content.length,
  };
}

function runSlackReadAction(
  request: DiscordToolActionRequest,
  targetSession: Session,
): Record<string, unknown> {
  if (
    normalizeValue(request.before) ||
    normalizeValue(request.after) ||
    normalizeValue(request.around)
  ) {
    throw new Error(
      'before, after, and around are not supported for Slack reads.',
    );
  }

  const limit = resolveReadLimit(request.limit);
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
    transport: 'slack',
    count: messages.length,
    messages,
  };
}

function runSlackChannelInfoAction(
  targetSession: Session,
): Record<string, unknown> {
  const parsed = parseSessionKey(targetSession.id);
  const target = parseSlackChannelTarget(targetSession.channel_id);
  return {
    ok: true,
    action: 'channel-info',
    transport: 'slack',
    channel: {
      id: targetSession.channel_id,
      sessionId: targetSession.id,
      teamId: targetSession.guild_id,
      isDm: parsed?.chatType === 'dm',
      threadTs: target?.threadTs || null,
      active: hasActiveSlackSession(targetSession.id),
      createdAt: targetSession.created_at,
      lastActive: targetSession.last_active,
    },
  };
}

function runSlackMemberInfoAction(
  request: DiscordToolActionRequest,
  targetSession: Session,
): Record<string, unknown> {
  const candidates = collectSlackMemberCandidates(targetSession.id);
  const lookup = resolveSlackMemberLookup(
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
      transport: 'slack',
      error: lookup.error,
      ...(lookup.candidates ? { candidates: lookup.candidates } : {}),
    };
  }

  return {
    ok: true,
    action: 'member-info',
    channelId: targetSession.channel_id,
    sessionId: targetSession.id,
    transport: 'slack',
    userId: lookup.candidate.id,
    ...(lookup.note ? { note: lookup.note } : {}),
    ...(lookup.candidates ? { candidates: lookup.candidates } : {}),
    member: {
      id: lookup.candidate.id,
      displayName: lookup.candidate.name,
      handle: `@${lookup.candidate.name}`,
      lastSeenAt: lookup.candidate.lastSeenAt,
    },
  };
}

export async function maybeRunSlackToolAction(
  request: DiscordToolActionRequest,
  params: {
    resolveSendFilePath: (request: DiscordToolActionRequest) => string | null;
  },
): Promise<Record<string, unknown> | null> {
  if (!isLikelySlackRequest(request)) {
    return null;
  }

  const targetSession = resolveKnownSlackSession(request);
  if (!targetSession) {
    throw new Error(
      'No known Slack conversation matched this request. Use the current Slack chat, `slack:current`, or a Slack target the gateway has already seen.',
    );
  }

  switch (request.action) {
    case 'send':
      return await runSlackSendAction(
        request,
        targetSession,
        params.resolveSendFilePath(request),
      );
    case 'read':
      return runSlackReadAction(request, targetSession);
    case 'channel-info':
      return runSlackChannelInfoAction(targetSession);
    case 'member-info':
      return runSlackMemberInfoAction(request, targetSession);
    default:
      return null;
  }
}
