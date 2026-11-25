/**
 * Address an external WhatsApp conversation to the configured default or its
 * explicitly selected agent. Each agent keeps its own history for that peer.
 */
import {
  getRuntimeConfig,
  resolveDefaultAgentId,
} from '../config/runtime-config.js';
import {
  buildSessionKey,
  classifySessionKeyShape,
} from '../session/session-key.js';

export function resolveWhatsAppChatTarget(
  channelId: string,
  sessionId: string | null | undefined,
  agentId: string | null | undefined,
): { sessionId?: string | null; agentId?: string | null } {
  if (
    channelId !== 'whatsapp' ||
    !sessionId ||
    classifySessionKeyShape(sessionId) !== 'opaque'
  ) {
    return { sessionId, agentId };
  }
  const target = agentId?.trim() || resolveDefaultAgentId(getRuntimeConfig());
  return {
    agentId: target,
    sessionId: buildSessionKey(target, 'whatsapp', 'dm', sessionId),
  };
}
