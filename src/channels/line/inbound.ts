import { DEFAULT_AGENT_ID } from '../../agents/agent-types.js';
import type {
  LineDmPolicy,
  LineGroupPolicy,
  RuntimeLineConfig,
} from '../../config/runtime-config.js';
import { buildSessionKey } from '../../session/session-key.js';
import type { MediaContextItem } from '../../types/container.js';
import { buildLineChannelId, normalizeLineUserId } from './target.js';

export interface LineSource {
  type?: 'user' | 'group' | 'room' | string;
  userId?: string;
  groupId?: string;
  roomId?: string;
}

export interface LineTextMessage {
  id?: string;
  type?: string;
  text?: string;
  mention?: {
    mentionees?: Array<{
      index?: number;
      length?: number;
      type?: string;
      userId?: string;
      isSelf?: boolean;
    }>;
  };
}

export interface LineWebhookEvent {
  type?: string;
  replyToken?: string;
  mode?: string;
  timestamp?: number;
  source?: LineSource;
  message?: LineTextMessage;
  postback?: {
    data?: string;
  };
  webhookEventId?: string;
  deliveryContext?: {
    isRedelivery?: boolean;
  };
}

export interface ProcessedLineInbound {
  sessionId: string;
  guildId: null;
  channelId: string;
  userId: string;
  username: string;
  content: string;
  media: MediaContextItem[];
  isGroup: boolean;
}

function normalizeLineAllowEntry(value: string): string | null {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  if (trimmed === '*') return '*';
  return normalizeLineUserId(trimmed) ?? null;
}

function normalizeAllowList(values: string[]): string[] {
  return [
    ...new Set(
      values
        .map((value) => normalizeLineAllowEntry(value))
        .filter((value): value is string => Boolean(value)),
    ),
  ];
}

function matchesAllowList(list: string[], senderId: string): boolean {
  return list.includes('*') || list.includes(senderId);
}

function messageMentionsBot(event: LineWebhookEvent): boolean {
  const mentionees = event.message?.mention?.mentionees;
  if (!Array.isArray(mentionees)) return false;
  return mentionees.some((mentionee) => mentionee?.isSelf === true);
}

function buildInboundText(event: LineWebhookEvent): string {
  if (event.type === 'postback') {
    return String(event.postback?.data || '')
      .replace(/\r\n?/g, '\n')
      .trim();
  }
  if (event.message?.type !== 'text') return '';
  return String(event.message.text || '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

function resolveLineSourceChannel(
  source: LineSource,
): { channelId: string; isGroup: boolean; senderId: string } | null {
  const senderId = normalizeLineUserId(source.userId || '');
  if (!senderId) return null;

  if (source.type === 'group') {
    const groupId = String(source.groupId || '').trim();
    if (!groupId) return null;
    return {
      channelId: buildLineChannelId(groupId, 'group'),
      isGroup: true,
      senderId,
    };
  }
  if (source.type === 'room') {
    const roomId = String(source.roomId || '').trim();
    if (!roomId) return null;
    return {
      channelId: buildLineChannelId(roomId, 'room'),
      isGroup: true,
      senderId,
    };
  }
  if (source.type !== 'user') return null;

  return {
    channelId: buildLineChannelId(senderId, 'user'),
    isGroup: false,
    senderId,
  };
}

export function evaluateLineAccessPolicy(params: {
  dmPolicy: LineDmPolicy;
  groupPolicy: LineGroupPolicy;
  allowFrom: string[];
  groupAllowFrom: string[];
  isGroup: boolean;
  senderId: string;
  requireMention: boolean;
  isMentioned: boolean;
}): { allowed: boolean; isGroup: boolean } {
  const allowFrom = normalizeAllowList(params.allowFrom);
  const groupAllowFrom =
    params.groupAllowFrom.length > 0
      ? normalizeAllowList(params.groupAllowFrom)
      : allowFrom;

  if (params.isGroup) {
    if (params.groupPolicy === 'disabled') {
      return { allowed: false, isGroup: true };
    }
    if (params.requireMention && !params.isMentioned) {
      return { allowed: false, isGroup: true };
    }
    if (params.groupPolicy === 'open') {
      return { allowed: true, isGroup: true };
    }
    return {
      allowed: matchesAllowList(groupAllowFrom, params.senderId),
      isGroup: true,
    };
  }

  if (params.dmPolicy === 'disabled') {
    return { allowed: false, isGroup: false };
  }
  if (params.dmPolicy === 'open') {
    return { allowed: true, isGroup: false };
  }
  return {
    allowed: matchesAllowList(allowFrom, params.senderId),
    isGroup: false,
  };
}

export function processInboundLineEvent(params: {
  config: RuntimeLineConfig;
  event: LineWebhookEvent;
  agentId?: string;
}): ProcessedLineInbound | null {
  const event = params.event;
  if (event.mode === 'standby') return null;
  if (event.type !== 'message' && event.type !== 'postback') return null;
  if (!event.source) return null;

  const source = resolveLineSourceChannel(event.source);
  if (!source) return null;

  const content = buildInboundText(event);
  if (!content) return null;

  const access = evaluateLineAccessPolicy({
    dmPolicy: params.config.dmPolicy,
    groupPolicy: params.config.groupPolicy,
    allowFrom: params.config.allowFrom,
    groupAllowFrom: params.config.groupAllowFrom,
    isGroup: source.isGroup,
    senderId: source.senderId,
    requireMention: params.config.requireMention,
    isMentioned: messageMentionsBot(event),
  });
  if (!access.allowed) return null;

  return {
    sessionId: buildSessionKey(
      params.agentId || DEFAULT_AGENT_ID,
      'line',
      source.isGroup ? 'group' : 'dm',
      source.channelId,
    ),
    guildId: null,
    channelId: source.channelId,
    userId: source.senderId,
    username: source.senderId,
    content,
    media: [],
    isGroup: source.isGroup,
  };
}
