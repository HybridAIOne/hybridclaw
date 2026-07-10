import type { TalkMessage } from '@jsr/evex__linejs';
import { DEFAULT_AGENT_ID } from '../../agents/agent-types.js';
import { buildSessionKey } from '../../session/session-key.js';
import { normalizeNativeAgentAddressingText } from '../agent-addressing.js';
import { buildLineChannelId } from './target.js';

const LINE_AGENT_REPLY_PREFIX_RE = /^\[HybridClaw\](?:\s|$)/i;

export interface ProcessedLineInbound {
  sessionId: string;
  guildId: null;
  channelId: string;
  userId: string;
  username: string;
  content: string;
  rawMessage: TalkMessage;
}

export function processInboundLineSelfMessage(params: {
  message: TalkMessage;
  selfMid: string;
  displayName?: string | null;
  agentId?: string;
}): ProcessedLineInbound | null {
  const selfMid = params.selfMid.trim().toLowerCase();
  if (!selfMid) return null;
  if (
    params.message.from.id.toLowerCase() !== selfMid ||
    params.message.to.id.toLowerCase() !== selfMid
  ) {
    return null;
  }
  if (params.message.raw.contentType !== 'NONE') return null;

  const content = normalizeNativeAgentAddressingText(params.message.text || '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!content || LINE_AGENT_REPLY_PREFIX_RE.test(content)) return null;

  const channelId = buildLineChannelId(selfMid);
  return {
    sessionId: buildSessionKey(
      params.agentId || DEFAULT_AGENT_ID,
      'line',
      'dm',
      selfMid,
    ),
    guildId: null,
    channelId,
    userId: selfMid,
    username: String(params.displayName || '').trim() || selfMid,
    content,
    rawMessage: params.message,
  };
}
