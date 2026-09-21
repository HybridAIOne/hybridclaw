/**
 * Chat routing presentation is a projection of persisted execution evidence.
 * The admin switch controls disclosure, never collection or route selection.
 */
import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import { getRuntimeConfig } from '../config/runtime-config.js';
import { logger } from '../logger.js';
import { setMessageRoutingTrace } from '../memory/messages.js';
import { redactSecretsDeep } from '../security/redact.js';
import { captureRoutingTrace } from '../usage/routing-trace.js';
import { enqueueTokenUsage } from '../usage/token-usage-buffer.js';
import type { GatewayChatRequest, GatewayChatResult } from './gateway-types.js';

export async function withChatRoutingTrace(
  req: GatewayChatRequest,
  work: () => Promise<GatewayChatResult>,
): Promise<GatewayChatResult> {
  const { result, trace } = await captureRoutingTrace(work, (progress) => {
    if (getRuntimeConfig().routing.showRoutingInfo)
      req.onRoutingTrace?.(redactSecretsDeep(progress));
  });
  if (!trace.attempts.length) return result;
  trace.status = result.status === 'error' ? 'error' : 'complete';
  const safeTrace = redactSecretsDeep(trace);
  const runId = makeAuditRunId('routing');
  for (const attempt of trace.attempts.filter(
    (entry) => entry.kind === 'auxiliary',
  )) {
    enqueueTokenUsage({
      sessionId: result.sessionId || req.sessionId,
      agentId: result.agentId || req.agentId || DEFAULT_AGENT_ID,
      model: attempt.model,
      inputTokens: attempt.inputTokens ?? 0,
      outputTokens: attempt.outputTokens ?? 0,
      totalTokens: attempt.totalTokens ?? 0,
      costUsd: attempt.costUsd ?? 0,
      auditRunId: runId,
      routeReason: attempt.reason,
    });
  }
  recordAuditEvent({
    sessionId: result.sessionId || req.sessionId,
    runId,
    event: {
      type: 'route.completed',
      assistantMessageId: result.assistantMessageId,
      trace: safeTrace,
    },
  });
  if (typeof result.assistantMessageId === 'number') {
    try {
      setMessageRoutingTrace(result.assistantMessageId, safeTrace);
    } catch (error) {
      logger.warn(
        { error, sessionId: req.sessionId },
        'Failed to persist routing trace',
      );
    }
  }
  return getRuntimeConfig().routing.showRoutingInfo
    ? { ...result, routingTrace: safeTrace }
    : result;
}
