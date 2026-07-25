const LINE_AGENT_REPLY_PREFIX_RE = /^\[HybridClaw\](?:\s|$)/i;

/**
 * Filters a LINE talk event down to the self-chat messages the agent should
 * handle and normalizes it into handler dispatch parameters.
 *
 * @param {import('@hybridaione/hybridclaw/plugin-sdk').LineTransportHost} host
 * @param {{
 *   message: import('@jsr/evex__linejs').TalkMessage;
 *   selfMid: string;
 *   displayName?: string | null;
 *   agentId?: string;
 * }} params
 */
export function processInboundLineSelfMessage(host, params) {
  const selfMid = params.selfMid.trim().toLowerCase();
  if (!selfMid) return null;
  if (
    params.message.from.id.toLowerCase() !== selfMid ||
    params.message.to.id.toLowerCase() !== selfMid
  ) {
    return null;
  }
  if (params.message.raw.contentType !== 'NONE') return null;

  const content = host.text
    .normalizeNativeAgentAddressingText(params.message.text || '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!content || LINE_AGENT_REPLY_PREFIX_RE.test(content)) return null;

  const channelId = host.target.buildChannelId(selfMid);
  return {
    sessionId: host.buildSessionKey(
      params.agentId || host.defaultAgentId,
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
