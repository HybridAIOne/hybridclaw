/**
 * HybridAI correlation headers — the one definition of how a model call names
 * the session, run, agent, channel and client it belongs to.
 *
 * HybridAI groups usage, observer conversations and run evidence by these
 * headers, so every call that is part of a conversation (the agent's own turns
 * in the worker and the gateway's helper calls alike) must send the same
 * session id, or it is counted as a separate conversation.
 *
 * Only `hybridai` receives them; other providers get their headers untouched.
 */

const HYBRIDAI_CORRELATION_HEADERS = {
  sessionId: 'X-HybridClaw-Session-Id',
  runId: 'X-HybridClaw-Run-Id',
  agentId: 'X-HybridClaw-Agent-Id',
  channelId: 'X-HybridClaw-Channel-Id',
  client: 'X-HybridClaw-Client',
} as const;

type HybridAICorrelationKey = keyof typeof HYBRIDAI_CORRELATION_HEADERS;

function normalizeHeaderValue(value: string | undefined): string {
  return String(value ?? '')
    .replace(/[^\x20-\x7e]/g, '')
    .trim()
    .slice(0, 256);
}

export function withHybridAICorrelationHeaders(
  params: Partial<Record<HybridAICorrelationKey, string>> & {
    provider: string | undefined;
    requestHeaders?: Record<string, string>;
  },
): Record<string, string> | undefined {
  if (params.provider !== 'hybridai') return params.requestHeaders;
  const headers = { ...(params.requestHeaders || {}) };
  for (const key of Object.keys(
    HYBRIDAI_CORRELATION_HEADERS,
  ) as HybridAICorrelationKey[]) {
    const value = normalizeHeaderValue(params[key]);
    if (value) headers[HYBRIDAI_CORRELATION_HEADERS[key]] = value;
  }
  return headers;
}
