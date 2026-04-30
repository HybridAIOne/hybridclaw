import type { RuntimeConfigChangeMeta } from '../config/runtime-config-revisions.js';
import { type A2AEnvelope, A2AEnvelopeValidationError } from './envelope.js';
import { listA2AInboxEnvelopes, saveA2AEnvelope } from './store.js';
import { isRecord } from './utils.js';

// Public server-side A2A runtime API required by roadmap #425.
export interface A2ADeliveryConfirmation {
  delivered: true;
  message_id: string;
  thread_id: string;
  recipient_agent_id: string;
}

function normalizeRuntimeEnvelope(envelope: unknown): unknown {
  if (!isRecord(envelope)) {
    throw new A2AEnvelopeValidationError(['envelope must be an object']);
  }
  return envelope;
}

export function sendMessage(
  envelope: unknown,
  meta?: RuntimeConfigChangeMeta,
): A2ADeliveryConfirmation {
  const deliveredEnvelope = saveA2AEnvelope(
    normalizeRuntimeEnvelope(envelope),
    {
      actor: meta?.actor,
      route: meta?.route || 'a2a.sendMessage',
      source: meta?.source || 'a2a-runtime',
    },
  );
  return {
    delivered: true,
    message_id: deliveredEnvelope.id,
    thread_id: deliveredEnvelope.thread_id,
    recipient_agent_id: deliveredEnvelope.recipient_agent_id,
  };
}

export function inbox(agentId: string): A2AEnvelope[] {
  if (!agentId.trim()) {
    throw new A2AEnvelopeValidationError(['agentId is required']);
  }
  return listA2AInboxEnvelopes(agentId);
}
