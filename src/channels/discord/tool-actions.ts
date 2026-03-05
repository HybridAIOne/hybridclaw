import type { Client, GuildMember } from 'discord.js';
import type {
  ResolveSendAllowedParams,
  ResolveSendAllowedResult,
} from './send-permissions.js';

export type DiscordToolAction =
  | 'read'
  | 'member-info'
  | 'channel-info'
  | 'send'
  | 'react'
  | 'quote-reply'
  | 'edit'
  | 'delete'
  | 'pin'
  | 'unpin'
  | 'thread-create'
  | 'thread-reply';

export function normalizeDiscordToolAction(
  rawAction: string | null | undefined,
): DiscordToolAction | null {
  const normalized = String(rawAction || '')
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  const compact = normalized.replace(/[\s_-]+/g, '');

  if (
    compact === 'read' ||
    compact === 'readmessages' ||
    compact === 'history' ||
    compact === 'fetch'
  ) {
    return 'read';
  }
  if (compact === 'memberinfo' || compact === 'lookup' || compact === 'whois') {
    return 'member-info';
  }
  if (compact === 'channelinfo') return 'channel-info';
  if (
    compact === 'react' ||
    compact === 'reaction' ||
    compact === 'reactions'
  ) {
    return 'react';
  }
  if (
    compact === 'quotereply' ||
    compact === 'replymessage' ||
    compact === 'replyto'
  ) {
    return 'quote-reply';
  }
  if (compact === 'edit' || compact === 'update') return 'edit';
  if (compact === 'delete' || compact === 'remove') return 'delete';
  if (compact === 'pin') return 'pin';
  if (compact === 'unpin') return 'unpin';
  if (compact === 'threadcreate' || compact === 'createthread') {
    return 'thread-create';
  }
  if (compact === 'threadreply' || compact === 'replythread') {
    return 'thread-reply';
  }
  if (
    compact === 'send' ||
    compact === 'sendmessage' ||
    compact === 'dm' ||
    compact === 'post' ||
    compact === 'reply' ||
    compact === 'respond'
  ) {
    return 'send';
  }
  return null;
}

export interface DiscordToolActionRequest {
  action: DiscordToolAction;
  channelId?: string;
  guildId?: string;
  userId?: string;
  username?: string;
  user?: string;
  memberId?: string;
  resolveAmbiguous?: 'error' | 'best';
  limit?: number;
  before?: string;
  after?: string;
  around?: string;
  content?: string;
  components?: unknown;
  contextChannelId?: string;
  messageId?: string;
  emoji?: string;
  name?: string;
  autoArchiveDuration?: number;
}

export interface CachedDiscordPresenceActivity {
  type: number;
  name: string;
  state: string | null;
  details: string | null;
}

export interface CachedDiscordPresence {
  status: string;
  activities: CachedDiscordPresenceActivity[];
}

export interface DiscordToolActionDependencies {
  requireDiscordClientReady: () => Client;
  getDiscordPresence: (userId: string) => CachedDiscordPresence | undefined;
  sendToChannel: (channelId: string, text: string) => Promise<void>;
  resolveSendAllowed: (
    params: ResolveSendAllowedParams,
  ) => ResolveSendAllowedResult;
}

function sanitizeDiscordId(
  rawValue: string | undefined,
  label: string,
): string {
  const value = (rawValue || '').trim();
  if (!/^\d{16,22}$/.test(value)) {
    throw new Error(`${label} must be a Discord snowflake id.`);
  }
  return value;
}

function normalizeDiscordUserLookupQuery(rawValue: string | undefined): string {
  const trimmed = (rawValue || '').trim();
  if (!trimmed) return '';

  const mentionMatch = trimmed.match(/^<@!?(\d{16,22})>$/);
  if (mentionMatch) return mentionMatch[1];
  const prefixedId = trimmed.match(/^(?:user:|discord:)?(\d{16,22})$/i);
  if (prefixedId) return prefixedId[1];

  return trimmed.replace(/^@+/, '').trim();
}

function normalizeDiscordChannelLookupQuery(
  rawValue: string | undefined,
): string {
  const trimmed = (rawValue || '').trim();
  if (!trimmed) return '';

  const mentionMatch = trimmed.match(/^<#(\d{16,22})>$/);
  if (mentionMatch) return mentionMatch[1];
  const prefixedId = trimmed.match(/^(?:channel:|discord:)?(\d{16,22})$/i);
  if (prefixedId) return prefixedId[1];

  return trimmed.replace(/^#+/, '').trim();
}

interface DiscordChannelLookupCandidate {
  id: string;
  name: string;
  isTextBased: boolean;
}

function scoreDiscordChannelForLookup(
  candidate: DiscordChannelLookupCandidate,
  query: string,
): number {
  const channelName = candidate.name.toLowerCase();
  const q = query.toLowerCase();
  if (!channelName || !q) return 0;

  let score = 0;
  if (channelName === q) score += 5;
  if (channelName.startsWith(q)) score += 2;
  if (channelName.includes(q)) score += 1;
  if (candidate.isTextBased) score += 1;
  return score;
}

function pickBestDiscordChannelLookupMatch(
  candidates: DiscordChannelLookupCandidate[],
  query: string,
): { channelId: string; note?: string } | null {
  let best: DiscordChannelLookupCandidate | null = null;
  let bestScore = 0;
  let matchCount = 0;

  for (const candidate of candidates) {
    const score = scoreDiscordChannelForLookup(candidate, query);
    if (score <= 0) continue;
    matchCount += 1;
    if (!best || score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  if (!best) return null;
  return {
    channelId: best.id,
    note: matchCount > 1 ? 'multiple matches; chose best' : undefined,
  };
}

function collectChannelLookupCandidates(
  channels: Iterable<unknown>,
): DiscordChannelLookupCandidate[] {
  const candidates: DiscordChannelLookupCandidate[] = [];
  for (const channel of channels) {
    if (!channel || typeof channel !== 'object') continue;
    const candidate = channel as {
      id?: string;
      name?: string;
      isTextBased?: () => boolean;
    };
    if (!candidate.id || !candidate.name) continue;
    candidates.push({
      id: candidate.id,
      name: candidate.name,
      isTextBased:
        typeof candidate.isTextBased === 'function'
          ? candidate.isTextBased()
          : false,
    });
  }
  return candidates;
}

async function resolveDiscordChannelIdFromLookup(params: {
  requireDiscordClientReady: () => Client;
  guildId?: string;
  rawChannel: string;
}): Promise<{ channelId: string; note?: string }> {
  const activeClient = params.requireDiscordClientReady();
  const normalized = normalizeDiscordChannelLookupQuery(params.rawChannel);
  if (!normalized) {
    throw new Error('channelId is required.');
  }
  if (/^\d{16,22}$/.test(normalized)) {
    return { channelId: normalized };
  }

  const searchQuery = normalized.slice(0, 64);
  if (!searchQuery) {
    throw new Error('channel name query is empty after normalization.');
  }

  const guildIdRaw = (params.guildId || '').trim();
  if (guildIdRaw) {
    const guildId = sanitizeDiscordId(guildIdRaw, 'guildId');
    const guild = await activeClient.guilds.fetch(guildId);
    const guildChannels = await guild.channels.fetch();
    const guildCandidates = collectChannelLookupCandidates(
      guildChannels.values(),
    );
    const matched = pickBestDiscordChannelLookupMatch(
      guildCandidates,
      searchQuery,
    );
    if (!matched) {
      throw new Error(
        `No channel matched "${searchQuery}" in guild ${guildId}.`,
      );
    }
    return matched;
  }

  const cachedCandidates = collectChannelLookupCandidates(
    activeClient.channels.cache.values(),
  );
  const cachedMatch = pickBestDiscordChannelLookupMatch(
    cachedCandidates,
    searchQuery,
  );
  if (cachedMatch) return cachedMatch;

  throw new Error(
    `No channel matched "${searchQuery}". Provide guildId when using channel names.`,
  );
}

function scoreGuildMemberForLookup(member: GuildMember, query: string): number {
  const q = query.toLowerCase();
  const username = member.user.username?.toLowerCase() || '';
  const globalName = member.user.globalName?.toLowerCase() || '';
  const nickname = member.nickname?.toLowerCase() || '';
  const displayName = member.displayName?.toLowerCase() || '';
  const candidates = [username, globalName, nickname, displayName].filter(
    Boolean,
  );

  let score = 0;
  if (candidates.some((value) => value === q)) score += 3;
  if (candidates.some((value) => value.includes(q))) score += 1;
  if (!member.user.bot) score += 1;
  return score;
}

interface DiscordMemberLookupCandidate {
  id: string;
  name: string;
  discriminator: string;
}

type GuildMemberLookupResult =
  | {
      ok: true;
      userId: string;
      note?: string;
      candidates?: DiscordMemberLookupCandidate[];
    }
  | {
      ok: false;
      error: string;
      candidates?: DiscordMemberLookupCandidate[];
    };

function toDiscordMemberLookupCandidate(
  member: GuildMember,
): DiscordMemberLookupCandidate {
  const fallbackName = member.user.username || member.id;
  return {
    id: member.id,
    name: member.displayName || member.user.globalName || fallbackName,
    discriminator: member.user.discriminator || '0',
  };
}

async function resolveGuildMemberIdFromLookup(params: {
  requireDiscordClientReady: () => Client;
  guildId: string;
  rawUser: string;
  resolveAmbiguous?: 'error' | 'best';
}): Promise<GuildMemberLookupResult> {
  const activeClient = params.requireDiscordClientReady();
  const guildId = sanitizeDiscordId(params.guildId, 'guildId');
  const normalized = normalizeDiscordUserLookupQuery(params.rawUser);
  if (!normalized) {
    throw new Error('userId or username is required.');
  }
  if (/^\d{16,22}$/.test(normalized)) {
    return { ok: true, userId: normalized };
  }

  const guild = await activeClient.guilds.fetch(guildId);
  const searchQuery = normalized.slice(0, 32);
  if (!searchQuery) {
    throw new Error('username query is empty after normalization.');
  }
  const resolveAmbiguous = params.resolveAmbiguous || 'error';

  let members: Map<string, GuildMember>;
  try {
    members = await guild.members.search({ query: searchQuery, limit: 25 });
  } catch {
    const fetched = await guild.members.fetch({
      query: searchQuery,
      limit: 25,
    });
    members = fetched;
  }
  const matched: Array<{ member: GuildMember; score: number }> = [];
  for (const member of members.values()) {
    const score = scoreGuildMemberForLookup(member, searchQuery);
    if (score <= 0) continue;
    matched.push({ member, score });
  }

  if (matched.length === 0) {
    return {
      ok: false,
      error: `No guild member matched username "${searchQuery}". Hint: use a Discord user ID, @mention, or exact username`,
    };
  }

  matched.sort(
    (a, b) =>
      b.score - a.score ||
      a.member.displayName.localeCompare(b.member.displayName) ||
      a.member.id.localeCompare(b.member.id),
  );

  if (matched.length > 1) {
    const sortedCandidates = matched
      .slice(0, 10)
      .map(({ member }) => toDiscordMemberLookupCandidate(member));
    if (resolveAmbiguous === 'best') {
      const best = matched[0];
      const others = sortedCandidates
        .slice(1)
        .map((candidate) => `${candidate.name} (${candidate.id})`)
        .join(', ');
      const bestCandidate = toDiscordMemberLookupCandidate(best.member);
      return {
        ok: true,
        userId: best.member.id,
        note: `Resolved ambiguous match to: ${bestCandidate.name} (score: ${best.score}). Other candidates: ${others || 'none'}.`,
        candidates: sortedCandidates,
      };
    }
    return {
      ok: false,
      error: `Ambiguous guild member match for "${searchQuery}". Provide a Discord user ID or exact username.`,
      candidates: sortedCandidates,
    };
  }

  return { ok: true, userId: matched[0].member.id };
}

function normalizeDate(value: Date | null | undefined): string | null {
  if (!value) return null;
  const ms = value.getTime();
  if (!Number.isFinite(ms)) return null;
  return value.toISOString();
}

function resolveMessageIdFromRequest(
  request: DiscordToolActionRequest,
  label: string = 'messageId',
): string {
  return sanitizeDiscordId(request.messageId, label);
}

async function resolveDiscordChannelForAction(
  request: DiscordToolActionRequest,
  deps: DiscordToolActionDependencies,
): Promise<{ channelId: string; channel: unknown; note?: string }> {
  const activeClient = deps.requireDiscordClientReady();
  const resolvedChannel = await resolveDiscordChannelIdFromLookup({
    requireDiscordClientReady: deps.requireDiscordClientReady,
    guildId: request.guildId,
    rawChannel: request.channelId || '',
  });
  const channelId = sanitizeDiscordId(resolvedChannel.channelId, 'channelId');
  const channel = await activeClient.channels.fetch(channelId);
  if (!channel) {
    throw new Error('Channel not found.');
  }
  return {
    channelId,
    channel,
    note: resolvedChannel.note,
  };
}

function resolveChannelGuildId(channel: unknown): string | undefined {
  if (
    channel &&
    typeof channel === 'object' &&
    'guildId' in channel &&
    typeof (channel as { guildId?: string }).guildId === 'string'
  ) {
    return (channel as { guildId?: string }).guildId;
  }
  return undefined;
}

async function resolveGuildIdFromContextChannel(params: {
  deps: DiscordToolActionDependencies;
  contextChannelId?: string;
}): Promise<string | undefined> {
  const rawContextChannelId = (params.contextChannelId || '').trim();
  if (!rawContextChannelId) return undefined;
  try {
    const activeClient = params.deps.requireDiscordClientReady();
    const contextChannelId = sanitizeDiscordId(
      rawContextChannelId,
      'contextChannelId',
    );
    const contextChannel = await activeClient.channels.fetch(contextChannelId);
    return resolveChannelGuildId(contextChannel);
  } catch {
    return undefined;
  }
}

async function resolveRequestingRoleIdsForSend(params: {
  channel: unknown;
  requestingUserId?: string;
}): Promise<string[] | undefined> {
  const { channel, requestingUserId } = params;
  if (!requestingUserId) return undefined;
  if (!channel || typeof channel !== 'object') return undefined;
  if (!('guild' in channel)) return undefined;
  const guildCandidate = (
    channel as { guild?: { id?: string; members?: unknown } }
  ).guild;
  if (!guildCandidate || typeof guildCandidate !== 'object') return undefined;
  const membersCandidate = guildCandidate.members;
  if (
    !membersCandidate ||
    typeof membersCandidate !== 'object' ||
    !('fetch' in membersCandidate) ||
    typeof (membersCandidate as { fetch?: unknown }).fetch !== 'function'
  ) {
    return undefined;
  }

  const member = await (
    membersCandidate as { fetch: (userId: string) => Promise<GuildMember> }
  )
    .fetch(requestingUserId)
    .catch(() => null);
  if (!member) return undefined;

  const guildId = guildCandidate.id || '';
  return member.roles.cache
    .filter((role) => role.id !== guildId)
    .map((role) => role.id);
}

async function ensureDiscordSendAllowed(params: {
  deps: DiscordToolActionDependencies;
  channel: unknown;
  channelId: string;
  request: DiscordToolActionRequest;
}): Promise<void> {
  const requestingUserIdRaw = (params.request.userId || '').trim();
  const requestingUserId = requestingUserIdRaw
    ? sanitizeDiscordId(requestingUserIdRaw, 'userId')
    : undefined;
  const guildId = resolveChannelGuildId(params.channel);
  const requestingRoleIds = await resolveRequestingRoleIdsForSend({
    channel: params.channel,
    requestingUserId,
  });

  const sendCheck = params.deps.resolveSendAllowed({
    channelId: params.channelId,
    guildId,
    requestingUserId,
    requestingRoleIds,
  });
  if (!sendCheck.allowed) {
    throw new Error(
      `Send denied for channel ${params.channelId}: ${sendCheck.reason || 'not allowed'}`,
    );
  }
}

type DiscordSendTargetResolution =
  | {
      ok: true;
      channelId: string;
      note?: string;
      candidates?: DiscordMemberLookupCandidate[];
    }
  | {
      ok: false;
      error: string;
      candidates?: DiscordMemberLookupCandidate[];
    };

function isLikelyUserTarget(rawTarget: string): boolean {
  const trimmed = rawTarget.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('@')) return true;
  if (/^<@!?\d{16,22}>$/.test(trimmed)) return true;
  if (/^(user:|discord:)\d{16,22}$/i.test(trimmed)) return true;
  return false;
}

function isExplicitUserReference(rawTarget: string): boolean {
  const trimmed = rawTarget.trim();
  return /^<@!?\d{16,22}>$/.test(trimmed) || /^user:\d{16,22}$/i.test(trimmed);
}

async function resolveDmChannelForUserId(params: {
  activeClient: Client;
  userId: string;
  rawTarget: string;
}): Promise<DiscordSendTargetResolution> {
  try {
    const user = await params.activeClient.users.fetch(params.userId);
    const dmChannel = await user.createDM();
    return {
      ok: true,
      channelId: sanitizeDiscordId(dmChannel.id, 'channelId'),
      note: `Resolved send target to DM user ${params.userId}.`,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Unable to resolve DM target "${params.rawTarget}": ${detail}`,
    };
  }
}

function resolveSendUserLookupTarget(
  request: DiscordToolActionRequest,
): string {
  return (request.user || request.username || '').trim();
}

async function resolveDmChannelForLookupTarget(params: {
  request: DiscordToolActionRequest;
  deps: DiscordToolActionDependencies;
  activeClient: Client;
  inferredGuildId?: string;
  rawTarget: string;
}): Promise<DiscordSendTargetResolution> {
  const normalizedUser = normalizeDiscordUserLookupQuery(params.rawTarget);
  if (!normalizedUser) {
    return {
      ok: false,
      error: 'User target is empty after normalization.',
    };
  }
  if (/^\d{16,22}$/.test(normalizedUser)) {
    return await resolveDmChannelForUserId({
      activeClient: params.activeClient,
      userId: normalizedUser,
      rawTarget: params.rawTarget,
    });
  }
  if (!params.inferredGuildId) {
    return {
      ok: false,
      error:
        'Unable to resolve user target. Provide guildId when sending to users by name, send from a guild channel context, or pass an explicit Discord user ID/@mention.',
    };
  }

  const resolvedUser = await resolveGuildMemberIdFromLookup({
    requireDiscordClientReady: params.deps.requireDiscordClientReady,
    guildId: params.inferredGuildId,
    rawUser: params.rawTarget,
    resolveAmbiguous: params.request.resolveAmbiguous,
  });
  if (!resolvedUser.ok) {
    return {
      ok: false,
      error: resolvedUser.error,
      ...(resolvedUser.candidates
        ? { candidates: resolvedUser.candidates }
        : {}),
    };
  }
  try {
    const user = await params.activeClient.users.fetch(resolvedUser.userId);
    const dmChannel = await user.createDM();
    return {
      ok: true,
      channelId: sanitizeDiscordId(dmChannel.id, 'channelId'),
      note:
        resolvedUser.note ||
        `Resolved send target to DM user ${resolvedUser.userId}.`,
      ...(resolvedUser.candidates
        ? { candidates: resolvedUser.candidates }
        : {}),
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Resolved user ${resolvedUser.userId} but failed to open DM: ${detail}`,
      ...(resolvedUser.candidates
        ? { candidates: resolvedUser.candidates }
        : {}),
    };
  }
}

async function resolveDiscordSendTarget(
  request: DiscordToolActionRequest,
  deps: DiscordToolActionDependencies,
): Promise<DiscordSendTargetResolution> {
  const activeClient = deps.requireDiscordClientReady();
  const explicitChannelTarget = (request.channelId || '').trim();
  const fallbackUserTarget = resolveSendUserLookupTarget(request);
  const rawTarget = explicitChannelTarget || fallbackUserTarget;
  if (!rawTarget) {
    throw new Error('channelId is required unless user/username is provided.');
  }
  const inferredGuildId =
    (request.guildId || '').trim() ||
    (await resolveGuildIdFromContextChannel({
      deps,
      contextChannelId: request.contextChannelId,
    }));

  if (!explicitChannelTarget && fallbackUserTarget) {
    return await resolveDmChannelForLookupTarget({
      request,
      deps,
      activeClient,
      inferredGuildId,
      rawTarget: fallbackUserTarget,
    });
  }

  const normalizedUser = normalizeDiscordUserLookupQuery(rawTarget);
  if (
    /^\d{16,22}$/.test(normalizedUser) &&
    isExplicitUserReference(rawTarget)
  ) {
    return await resolveDmChannelForUserId({
      activeClient,
      userId: normalizedUser,
      rawTarget,
    });
  }

  try {
    const resolvedChannel = await resolveDiscordChannelIdFromLookup({
      requireDiscordClientReady: deps.requireDiscordClientReady,
      guildId: inferredGuildId,
      rawChannel: rawTarget,
    });
    const resolvedChannelId = sanitizeDiscordId(
      resolvedChannel.channelId,
      'channelId',
    );
    if (
      /^\d{16,22}$/.test(normalizedUser) &&
      normalizedUser === resolvedChannelId
    ) {
      const resolvedChannelExists = await activeClient.channels
        .fetch(resolvedChannelId)
        .catch(() => null);
      if (!resolvedChannelExists) {
        const dmResolution = await resolveDmChannelForUserId({
          activeClient,
          userId: normalizedUser,
          rawTarget,
        });
        if (dmResolution.ok) return dmResolution;
      }
    }
    return {
      ok: true,
      channelId: resolvedChannelId,
      note: resolvedChannel.note,
    };
  } catch (channelError) {
    if (/^\d{16,22}$/.test(normalizedUser)) {
      return await resolveDmChannelForUserId({
        activeClient,
        userId: normalizedUser,
        rawTarget,
      });
    }

    if (inferredGuildId || isLikelyUserTarget(rawTarget)) {
      return await resolveDmChannelForLookupTarget({
        request,
        deps,
        activeClient,
        inferredGuildId,
        rawTarget,
      });
    }

    throw channelError;
  }
}

async function fetchDiscordMessageForAction(params: {
  request: DiscordToolActionRequest;
  deps: DiscordToolActionDependencies;
  actionLabel: string;
}): Promise<{
  channelId: string;
  channel: unknown;
  messageId: string;
  message: unknown;
  note?: string;
}> {
  const resolved = await resolveDiscordChannelForAction(
    params.request,
    params.deps,
  );
  const channel = resolved.channel as {
    messages?: { fetch?: (messageId: string) => Promise<unknown> };
  };
  if (
    !channel ||
    typeof channel !== 'object' ||
    !channel.messages ||
    typeof channel.messages.fetch !== 'function'
  ) {
    throw new Error(`Channel does not support ${params.actionLabel}.`);
  }
  const messageId = resolveMessageIdFromRequest(params.request);
  const message = await channel.messages.fetch(messageId);
  if (!message) {
    throw new Error(`Message ${messageId} not found.`);
  }
  return {
    channelId: resolved.channelId,
    channel: resolved.channel,
    messageId,
    message,
    note: resolved.note,
  };
}

async function runDiscordReadAction(
  request: DiscordToolActionRequest,
  deps: DiscordToolActionDependencies,
): Promise<Record<string, unknown>> {
  const activeClient = deps.requireDiscordClientReady();
  const resolvedChannel = await resolveDiscordChannelIdFromLookup({
    requireDiscordClientReady: deps.requireDiscordClientReady,
    guildId: request.guildId,
    rawChannel: request.channelId || '',
  });
  const channelId = sanitizeDiscordId(resolvedChannel.channelId, 'channelId');
  const channel = await activeClient.channels.fetch(channelId);
  if (!channel || !('messages' in channel)) {
    throw new Error('Channel does not support message reads.');
  }

  const requestedLimit =
    typeof request.limit === 'number' && Number.isFinite(request.limit)
      ? Math.floor(request.limit)
      : 20;
  const limit = Math.max(1, Math.min(100, requestedLimit));
  const before = request.before?.trim();
  const after = request.after?.trim();
  const around = request.around?.trim();

  const query: {
    limit: number;
    before?: string;
    after?: string;
    around?: string;
  } = { limit };
  if (before) query.before = before;
  if (after) query.after = after;
  if (around) query.around = around;

  const fetched = await channel.messages.fetch(query);
  const messages = Array.from(fetched.values())
    .sort(
      (a, b) =>
        a.createdTimestamp - b.createdTimestamp || a.id.localeCompare(b.id),
    )
    .map((message) => ({
      id: message.id,
      channelId: message.channelId,
      guildId: message.guildId ?? null,
      content: message.content || '',
      createdAt: new Date(message.createdTimestamp).toISOString(),
      editedAt: normalizeDate(message.editedAt),
      author: {
        id: message.author?.id || 'unknown',
        username: message.author?.username || 'unknown',
        handle: message.author?.username ? `@${message.author.username}` : null,
        globalName: message.author?.globalName || null,
        bot: Boolean(message.author?.bot),
      },
      member: message.member
        ? {
            id: message.member.id,
            nickname: message.member.nickname || null,
            displayName: message.member.displayName || null,
          }
        : null,
      attachments: Array.from(message.attachments.values()).map(
        (attachment) => ({
          id: attachment.id,
          name: attachment.name || null,
          url: attachment.url,
          contentType: attachment.contentType || null,
          size: attachment.size,
        }),
      ),
      mentions: {
        users: Array.from(message.mentions.users.values()).map((user) => ({
          id: user.id,
          username: user.username,
          bot: Boolean(user.bot),
        })),
        roles: Array.from(message.mentions.roles.values()).map((role) => ({
          id: role.id,
          name: role.name,
        })),
        channels: Array.from(message.mentions.channels.values()).map(
          (mentionedChannel) => ({
            id: mentionedChannel.id,
            name:
              'name' in mentionedChannel &&
              typeof mentionedChannel.name === 'string'
                ? mentionedChannel.name
                : null,
          }),
        ),
      },
    }));

  return {
    ok: true,
    action: 'read',
    channelId,
    ...(resolvedChannel.note ? { note: resolvedChannel.note } : {}),
    count: messages.length,
    messages,
  };
}

async function runDiscordMemberInfoAction(
  request: DiscordToolActionRequest,
  deps: DiscordToolActionDependencies,
): Promise<Record<string, unknown>> {
  const activeClient = deps.requireDiscordClientReady();
  const guildId = sanitizeDiscordId(request.guildId, 'guildId');
  const userLookupRaw =
    request.userId || request.memberId || request.user || request.username;
  const resolvedUser = await resolveGuildMemberIdFromLookup({
    requireDiscordClientReady: deps.requireDiscordClientReady,
    guildId,
    rawUser: userLookupRaw || '',
    resolveAmbiguous: request.resolveAmbiguous,
  });
  if (!resolvedUser.ok) {
    return {
      ok: false,
      action: 'member-info',
      guildId,
      error: resolvedUser.error,
      ...(resolvedUser.candidates
        ? { candidates: resolvedUser.candidates }
        : {}),
    };
  }
  const userId = sanitizeDiscordId(resolvedUser.userId, 'userId');

  const guild = await activeClient.guilds.fetch(guildId);
  const member = await guild.members.fetch(userId);
  const presence = deps.getDiscordPresence(userId);

  const roles = member.roles.cache
    .filter((role) => role.id !== guild.id)
    .map((role) => ({
      id: role.id,
      name: role.name,
      color: role.hexColor,
      position: role.position,
    }))
    .sort((a, b) => b.position - a.position || a.name.localeCompare(b.name));

  return {
    ok: true,
    action: 'member-info',
    guildId,
    userId,
    ...(resolvedUser.note ? { note: resolvedUser.note } : {}),
    ...(resolvedUser.candidates ? { candidates: resolvedUser.candidates } : {}),
    member: {
      id: member.id,
      username: member.user.username,
      handle: member.user.username ? `@${member.user.username}` : null,
      globalName: member.user.globalName || null,
      bot: Boolean(member.user.bot),
      displayName: member.displayName,
      nickname: member.nickname || null,
      joinedAt: normalizeDate(member.joinedAt),
      premiumSince: normalizeDate(member.premiumSince),
      communicationDisabledUntil: normalizeDate(
        member.communicationDisabledUntil,
      ),
      roles,
    },
    ...(presence
      ? {
          status: presence.status,
          activities: presence.activities,
        }
      : {}),
  };
}

async function runDiscordChannelInfoAction(
  request: DiscordToolActionRequest,
  deps: DiscordToolActionDependencies,
): Promise<Record<string, unknown>> {
  const activeClient = deps.requireDiscordClientReady();
  const resolvedChannel = await resolveDiscordChannelIdFromLookup({
    requireDiscordClientReady: deps.requireDiscordClientReady,
    guildId: request.guildId,
    rawChannel: request.channelId || '',
  });
  const channelId = sanitizeDiscordId(resolvedChannel.channelId, 'channelId');
  const channel = await activeClient.channels.fetch(channelId);
  if (!channel) {
    throw new Error('Channel not found.');
  }

  const channelData: Record<string, unknown> = {
    id: channel.id,
    type: channel.type,
    guildId: 'guildId' in channel ? channel.guildId || null : null,
    name:
      'name' in channel && typeof channel.name === 'string'
        ? channel.name
        : null,
    parentId: 'parentId' in channel ? channel.parentId || null : null,
    topic:
      'topic' in channel && typeof channel.topic === 'string'
        ? channel.topic
        : null,
    nsfw:
      'nsfw' in channel && typeof channel.nsfw === 'boolean'
        ? channel.nsfw
        : null,
    rateLimitPerUser:
      'rateLimitPerUser' in channel &&
      typeof channel.rateLimitPerUser === 'number'
        ? channel.rateLimitPerUser
        : null,
    isTextBased:
      typeof channel.isTextBased === 'function' ? channel.isTextBased() : false,
    isDMBased:
      typeof channel.isDMBased === 'function' ? channel.isDMBased() : false,
    isThread:
      typeof channel.isThread === 'function' ? channel.isThread() : false,
    lastMessageId:
      'lastMessageId' in channel ? channel.lastMessageId || null : null,
  };

  if (typeof channel.isThread === 'function' && channel.isThread()) {
    channelData.archived =
      'archived' in channel && typeof channel.archived === 'boolean'
        ? channel.archived
        : null;
    channelData.locked =
      'locked' in channel && typeof channel.locked === 'boolean'
        ? channel.locked
        : null;
    channelData.ownerId = 'ownerId' in channel ? channel.ownerId || null : null;
  }

  return {
    ok: true,
    action: 'channel-info',
    ...(resolvedChannel.note ? { note: resolvedChannel.note } : {}),
    channel: channelData,
  };
}

async function runDiscordSendAction(
  request: DiscordToolActionRequest,
  deps: DiscordToolActionDependencies,
): Promise<Record<string, unknown>> {
  const activeClient = deps.requireDiscordClientReady();
  const resolvedTarget = await resolveDiscordSendTarget(request, deps);
  if (!resolvedTarget.ok) {
    return {
      ok: false,
      action: 'send',
      error: resolvedTarget.error,
      ...(resolvedTarget.candidates
        ? { candidates: resolvedTarget.candidates }
        : {}),
    };
  }
  const channelId = sanitizeDiscordId(resolvedTarget.channelId, 'channelId');
  const content = (request.content || '').trim();
  const hasComponents =
    Array.isArray(request.components) ||
    (request.components !== null && typeof request.components === 'object');
  if (!content && !hasComponents) {
    throw new Error(
      'content is required for send action unless components are provided.',
    );
  }

  const channel = await activeClient.channels.fetch(channelId);
  if (!channel || !('send' in channel)) {
    throw new Error('Channel does not support sending messages.');
  }
  await ensureDiscordSendAllowed({
    deps,
    channel,
    channelId,
    request,
  });

  if (hasComponents) {
    const sendableChannel = channel as {
      send?: (payload: {
        content?: string;
        components?: unknown;
      }) => Promise<{ id?: string }>;
    };
    if (typeof sendableChannel.send !== 'function') {
      throw new Error('Channel does not support sending component messages.');
    }
    await sendableChannel.send({
      ...(content ? { content } : {}),
      components: request.components,
    });
  } else {
    await deps.sendToChannel(channelId, content);
  }

  return {
    ok: true,
    action: 'send',
    channelId,
    ...(resolvedTarget.note ? { note: resolvedTarget.note } : {}),
    ...(resolvedTarget.candidates
      ? { candidates: resolvedTarget.candidates }
      : {}),
    contentLength: content.length,
    ...(hasComponents ? { componentsIncluded: true } : {}),
  };
}

async function runDiscordReactAction(
  request: DiscordToolActionRequest,
  deps: DiscordToolActionDependencies,
): Promise<Record<string, unknown>> {
  const emoji = (request.emoji || request.content || '').trim();
  if (!emoji) {
    throw new Error('emoji is required for react action.');
  }
  const resolved = await fetchDiscordMessageForAction({
    request,
    deps,
    actionLabel: 'reactions',
  });
  const message = resolved.message as {
    react: (emoji: string) => Promise<unknown>;
  };
  if (typeof message.react !== 'function') {
    throw new Error('Message does not support reactions.');
  }
  await message.react(emoji);
  return {
    ok: true,
    action: 'react',
    channelId: resolved.channelId,
    messageId: resolved.messageId,
    emoji,
    ...(resolved.note ? { note: resolved.note } : {}),
  };
}

async function runDiscordQuoteReplyAction(
  request: DiscordToolActionRequest,
  deps: DiscordToolActionDependencies,
): Promise<Record<string, unknown>> {
  const content = (request.content || '').trim();
  if (!content) {
    throw new Error('content is required for quote-reply action.');
  }
  const resolved = await fetchDiscordMessageForAction({
    request,
    deps,
    actionLabel: 'replies',
  });
  await ensureDiscordSendAllowed({
    deps,
    channel: resolved.channel,
    channelId: resolved.channelId,
    request,
  });
  const message = resolved.message as {
    reply: (payload: string | { content: string }) => Promise<{ id: string }>;
  };
  if (typeof message.reply !== 'function') {
    throw new Error('Message does not support replies.');
  }
  const sent = await message.reply({ content });
  return {
    ok: true,
    action: 'quote-reply',
    channelId: resolved.channelId,
    messageId: resolved.messageId,
    replyMessageId: sent?.id || null,
    ...(resolved.note ? { note: resolved.note } : {}),
    contentLength: content.length,
  };
}

async function runDiscordEditAction(
  request: DiscordToolActionRequest,
  deps: DiscordToolActionDependencies,
): Promise<Record<string, unknown>> {
  const content = (request.content || '').trim();
  if (!content) {
    throw new Error('content is required for edit action.');
  }
  const resolved = await fetchDiscordMessageForAction({
    request,
    deps,
    actionLabel: 'edits',
  });
  const activeClient = deps.requireDiscordClientReady();
  const message = resolved.message as {
    author?: { id?: string };
    edit?: (payload: string | { content: string }) => Promise<{ id: string }>;
  };
  const botUserId = activeClient.user?.id || '';
  if (botUserId && message.author?.id && message.author.id !== botUserId) {
    throw new Error('Only bot-authored messages can be edited.');
  }
  if (typeof message.edit !== 'function') {
    throw new Error('Message does not support edits.');
  }
  const edited = await message.edit({ content });
  return {
    ok: true,
    action: 'edit',
    channelId: resolved.channelId,
    messageId: resolved.messageId,
    editedMessageId: edited?.id || null,
    ...(resolved.note ? { note: resolved.note } : {}),
    contentLength: content.length,
  };
}

async function runDiscordDeleteAction(
  request: DiscordToolActionRequest,
  deps: DiscordToolActionDependencies,
): Promise<Record<string, unknown>> {
  const resolved = await fetchDiscordMessageForAction({
    request,
    deps,
    actionLabel: 'deletes',
  });
  const message = resolved.message as { delete?: () => Promise<unknown> };
  if (typeof message.delete !== 'function') {
    throw new Error('Message does not support delete.');
  }
  await message.delete();
  return {
    ok: true,
    action: 'delete',
    channelId: resolved.channelId,
    messageId: resolved.messageId,
    ...(resolved.note ? { note: resolved.note } : {}),
  };
}

async function runDiscordPinAction(
  request: DiscordToolActionRequest,
  deps: DiscordToolActionDependencies,
  mode: 'pin' | 'unpin',
): Promise<Record<string, unknown>> {
  const resolved = await fetchDiscordMessageForAction({
    request,
    deps,
    actionLabel: mode === 'pin' ? 'pinning' : 'unpinning',
  });
  const message = resolved.message as {
    pin?: () => Promise<unknown>;
    unpin?: () => Promise<unknown>;
  };
  if (mode === 'pin') {
    if (typeof message.pin !== 'function') {
      throw new Error('Message does not support pin.');
    }
    await message.pin();
  } else {
    if (typeof message.unpin !== 'function') {
      throw new Error('Message does not support unpin.');
    }
    await message.unpin();
  }
  return {
    ok: true,
    action: mode,
    channelId: resolved.channelId,
    messageId: resolved.messageId,
    ...(resolved.note ? { note: resolved.note } : {}),
  };
}

async function runDiscordThreadCreateAction(
  request: DiscordToolActionRequest,
  deps: DiscordToolActionDependencies,
): Promise<Record<string, unknown>> {
  const threadName = (request.name || '').trim();
  if (!threadName) {
    throw new Error('name is required for thread-create action.');
  }
  const resolved = await fetchDiscordMessageForAction({
    request,
    deps,
    actionLabel: 'thread creation',
  });
  const message = resolved.message as {
    startThread?: (options: {
      name: string;
      autoArchiveDuration?: number;
      reason?: string;
    }) => Promise<{ id: string; name?: string }>;
  };
  if (typeof message.startThread !== 'function') {
    throw new Error('Message does not support thread creation.');
  }
  const autoArchiveDuration =
    typeof request.autoArchiveDuration === 'number' &&
    Number.isFinite(request.autoArchiveDuration)
      ? Math.max(60, Math.floor(request.autoArchiveDuration))
      : undefined;
  const thread = await message.startThread({
    name: threadName,
    ...(autoArchiveDuration ? { autoArchiveDuration } : {}),
    reason: 'Created via message tool',
  });
  return {
    ok: true,
    action: 'thread-create',
    channelId: resolved.channelId,
    messageId: resolved.messageId,
    threadId: thread.id,
    threadName: thread.name || threadName,
    ...(resolved.note ? { note: resolved.note } : {}),
  };
}

async function runDiscordThreadReplyAction(
  request: DiscordToolActionRequest,
  deps: DiscordToolActionDependencies,
): Promise<Record<string, unknown>> {
  const content = (request.content || '').trim();
  if (!content) {
    throw new Error('content is required for thread-reply action.');
  }
  const resolved = await resolveDiscordChannelForAction(request, deps);
  const channel = resolved.channel as {
    isThread?: () => boolean;
    send?: (payload: string | { content: string }) => Promise<{ id: string }>;
  };
  if (typeof channel.isThread !== 'function' || !channel.isThread()) {
    throw new Error('channelId must reference a thread for thread-reply.');
  }
  if (typeof channel.send !== 'function') {
    throw new Error('Thread does not support sending messages.');
  }
  await ensureDiscordSendAllowed({
    deps,
    channel: resolved.channel,
    channelId: resolved.channelId,
    request,
  });
  const sent = await channel.send({ content });
  return {
    ok: true,
    action: 'thread-reply',
    channelId: resolved.channelId,
    sentMessageId: sent?.id || null,
    ...(resolved.note ? { note: resolved.note } : {}),
    contentLength: content.length,
  };
}

export function createDiscordToolActionRunner(
  deps: DiscordToolActionDependencies,
): (request: DiscordToolActionRequest) => Promise<Record<string, unknown>> {
  return async (request: DiscordToolActionRequest) => {
    switch (request.action) {
      case 'read':
        return await runDiscordReadAction(request, deps);
      case 'member-info':
        return await runDiscordMemberInfoAction(request, deps);
      case 'channel-info':
        return await runDiscordChannelInfoAction(request, deps);
      case 'send':
        return await runDiscordSendAction(request, deps);
      case 'react':
        return await runDiscordReactAction(request, deps);
      case 'quote-reply':
        return await runDiscordQuoteReplyAction(request, deps);
      case 'edit':
        return await runDiscordEditAction(request, deps);
      case 'delete':
        return await runDiscordDeleteAction(request, deps);
      case 'pin':
        return await runDiscordPinAction(request, deps, 'pin');
      case 'unpin':
        return await runDiscordPinAction(request, deps, 'unpin');
      case 'thread-create':
        return await runDiscordThreadCreateAction(request, deps);
      case 'thread-reply':
        return await runDiscordThreadReplyAction(request, deps);
      default:
        throw new Error(
          `Unsupported Discord action: ${request.action as string}`,
        );
    }
  };
}
