import type { RuntimeConfigChangeMeta } from '../config/runtime-config-revisions.js';
import type { A2AEnvelope } from './envelope.js';
import { listA2AInboxEnvelopes, saveA2AEnvelope } from './store.js';
import { isRecord } from './utils.js';

export interface A2ADeliveryConfirmation {
  delivered: true;
  message_id: string;
  thread_id: string;
  recipient_coworker_id: string;
  delivered_at: string;
  envelope: A2AEnvelope;
}

function sendMessageMeta(
  meta?: RuntimeConfigChangeMeta,
): RuntimeConfigChangeMeta {
  return {
    actor: meta?.actor,
    route: meta?.route || 'a2a.sendMessage',
    source: meta?.source || 'a2a-runtime',
  };
}

function normalizeRuntimeEnvelope(envelope: unknown): unknown {
  if (!isRecord(envelope)) return envelope;
  const normalized = { ...envelope };
  if (
    normalized.sender_agent_id === undefined &&
    normalized.sender_coworker_id !== undefined
  ) {
    normalized.sender_agent_id = normalized.sender_coworker_id;
  }
  if (
    normalized.recipient_agent_id === undefined &&
    normalized.recipient_coworker_id !== undefined
  ) {
    normalized.recipient_agent_id = normalized.recipient_coworker_id;
  }
  delete normalized.sender_coworker_id;
  delete normalized.recipient_coworker_id;
  return normalized;
}

export function sendMessage(
  envelope: unknown,
  meta?: RuntimeConfigChangeMeta,
): A2ADeliveryConfirmation {
  const deliveredEnvelope = saveA2AEnvelope(
    normalizeRuntimeEnvelope(envelope),
    sendMessageMeta(meta),
  );
  return {
    delivered: true,
    message_id: deliveredEnvelope.id,
    thread_id: deliveredEnvelope.thread_id,
    recipient_coworker_id: deliveredEnvelope.recipient_agent_id,
    delivered_at: new Date().toISOString(),
    envelope: deliveredEnvelope,
  };
}

export function inbox(coworkerId: string): A2AEnvelope[] {
  return listA2AInboxEnvelopes(coworkerId);
}
