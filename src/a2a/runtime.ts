import type { EscalationTarget } from '../types/execution.js';
import { type A2AEnvelope, A2AEnvelopeValidationError } from './envelope.js';
import { attachA2AHandoffContext } from './handoff-context.js';
import { listA2AInboxEnvelopes, saveA2AEnvelope } from './store.js';
import {
  encodeForRegisteredTransport,
  type TransportRegistry,
} from './transport-registry.js';
import { isRecord } from './utils.js';

// Public server-side A2A runtime API required by roadmap #425.
export interface A2ADeliveryConfirmation {
  delivered: true;
  message_id: string;
  thread_id: string;
  recipient_agent_id: string;
}

export interface A2ASendMessageMeta {
  actor?: string;
  peerDescriptor?: unknown;
  transportRegistry?: TransportRegistry;
  sessionId?: string;
  auditRunId?: string;
  escalationTarget?: EscalationTarget;
}

function normalizeRuntimeEnvelope(envelope: unknown): unknown {
  if (!isRecord(envelope)) {
    throw new A2AEnvelopeValidationError(['envelope must be an object']);
  }
  return envelope;
}

/**
 * Trusted in-process primitive for persisting an A2A envelope.
 * `actor` is audit metadata; sender authorization belongs at transport/tool boundaries.
 */
export function sendMessage(
  envelope: unknown,
  meta?: A2ASendMessageMeta,
): A2ADeliveryConfirmation {
  const encodedEnvelope = encodeForRegisteredTransport({
    envelope: attachA2AHandoffContext(normalizeRuntimeEnvelope(envelope)),
    peerDescriptor: meta?.peerDescriptor,
    registry: meta?.transportRegistry,
    sessionId: meta?.sessionId,
    runId: meta?.auditRunId,
    escalationTarget: meta?.escalationTarget,
  });
  const deliveredEnvelope = saveA2AEnvelope(encodedEnvelope, {
    actor: meta?.actor,
    route: 'a2a.sendMessage',
    source: 'a2a-runtime',
  });
  return {
    delivered: true,
    message_id: deliveredEnvelope.id,
    thread_id: deliveredEnvelope.thread_id,
    recipient_agent_id: deliveredEnvelope.recipient_agent_id,
  };
}

/**
 * Returns all persisted envelopes received by `agentId`, sorted by `created_at`
 * and then id. Read/unread state and pagination are intentionally out of scope.
 */
export function inbox(agentId: string): A2AEnvelope[] {
  if (!agentId.trim()) {
    throw new A2AEnvelopeValidationError(['agentId is required']);
  }
  return listA2AInboxEnvelopes(agentId);
}
