import type { A2AEnvelope } from './envelope.js';
import { type A2ADeliveryConfirmation, sendMessage } from './runtime.js';

export interface A2AInboundPipelineMeta {
  actor: string;
  source: 'webhook';
  sessionId?: string;
  auditRunId?: string;
}

export function acceptA2AInboundEnvelope(
  envelope: A2AEnvelope,
  meta: A2AInboundPipelineMeta,
): A2ADeliveryConfirmation {
  return sendMessage(envelope, {
    actor: `${meta.source}:${meta.actor}`,
    sessionId: meta.sessionId,
    auditRunId: meta.auditRunId,
  });
}
