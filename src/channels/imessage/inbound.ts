import { DEFAULT_AGENT_ID } from '../../agents/agent-types.js';
import type {
  IMessageDmPolicy,
  IMessageGroupPolicy,
  RuntimeIMessageConfig,
} from '../../config/runtime-config.js';
import { buildSessionKey } from '../../session/session-key.js';
import type { MediaContextItem } from '../../types/container.js';
import { buildIMessageChannelId, normalizeIMessageHandle } from './handle.js';
import type { IMessageInbound } from './types.js';

function normalizeAllowEntry(value: string): string | null {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  if (trimmed === '*') return '*';
  return normalizeIMessageHandle(trimmed);
}

function normalizeAllowList(values: string[]): string[] {
  const normalized = values
    .map((entry) => normalizeAllowEntry(entry))
    .filter((entry): entry is string => Boolean(entry));
  return [...new Set(normalized)];
}

function matchesAllowList(list: string[], handle: string): boolean {
  if (list.includes('*')) return true;
  return list.includes(handle);
}

export function evaluateIMessageAccessPolicy(params: {
  dmPolicy: IMessageDmPolicy;
  groupPolicy: IMessageGroupPolicy;
  allowFrom: string[];
  groupAllowFrom: string[];
  handle: string;
  isGroup: boolean;
  isFromMe: boolean;
}): { allowed: boolean; isGroup: boolean } {
  if (params.isFromMe) {
    return { allowed: false, isGroup: params.isGroup };
  }

  const allowFrom = normalizeAllowList(params.allowFrom);
  const groupAllowFrom =
    params.groupAllowFrom.length > 0
      ? normalizeAllowList(params.groupAllowFrom)
      : allowFrom;

  if (params.isGroup) {
    if (params.groupPolicy === 'disabled') {
      return { allowed: false, isGroup: true };
    }
    if (params.groupPolicy === 'open') {
      return { allowed: true, isGroup: true };
    }
    return {
      allowed: matchesAllowList(groupAllowFrom, params.handle),
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
    allowed: matchesAllowList(allowFrom, params.handle),
    isGroup: false,
  };
}

export function normalizeIMessageInbound(params: {
  config: RuntimeIMessageConfig;
  backend: IMessageInbound['backend'];
  conversationId: string;
  senderHandle: string;
  text: string;
  isGroup: boolean;
  isFromMe: boolean;
  displayName?: string | null;
  media?: MediaContextItem[];
  messageId?: string | null;
  rawEvent: unknown;
  agentId?: string;
}): IMessageInbound | null {
  const handle = normalizeIMessageHandle(params.senderHandle);
  if (!handle) return null;

  const access = evaluateIMessageAccessPolicy({
    dmPolicy: params.config.dmPolicy,
    groupPolicy: params.config.groupPolicy,
    allowFrom: params.config.allowFrom,
    groupAllowFrom: params.config.groupAllowFrom,
    handle,
    isGroup: params.isGroup,
    isFromMe: params.isFromMe,
  });
  if (!access.allowed) return null;

  const content = String(params.text || '').trim();
  const media = params.media ?? [];
  if (!content && media.length === 0) return null;

  const channelId = access.isGroup
    ? buildIMessageChannelId(`chat:${params.conversationId}`)
    : buildIMessageChannelId(handle);

  return {
    sessionId: buildSessionKey(
      params.agentId || DEFAULT_AGENT_ID,
      'imessage',
      access.isGroup ? 'channel' : 'dm',
      channelId,
    ),
    guildId: null,
    channelId,
    userId: handle,
    username: String(params.displayName || '').trim() || handle,
    content,
    media,
    messageId: String(params.messageId || '').trim() || null,
    conversationId: String(params.conversationId || '').trim() || channelId,
    handle,
    isGroup: access.isGroup,
    backend: params.backend,
    rawEvent: params.rawEvent,
  };
}
