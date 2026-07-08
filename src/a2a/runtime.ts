import { IDENTITY_DISCOVERY_ZONE_ENV } from '../identity/resolver.js';
import { logger } from '../logger.js';
import type { EscalationTarget } from '../types/execution.js';
import { enqueueA2AInboxDispatch } from './a2a-inbox-dispatch-store.js';
import { enqueueUnresolvedA2AEnvelope } from './a2a-outbound.js';
import { recordA2AMessageAudit } from './audit.js';
import {
  type A2AEnvelope,
  A2AEnvelopeValidationError,
  validateA2AEnvelope,
} from './envelope.js';
import { attachA2AHandoffContext } from './handoff-context.js';
import { isLocalA2AAgentId, resolveA2AEnvelopeAgentIds } from './identity.js';
import { normalizePeerDescriptor } from './peer-descriptor.js';
import {
  type A2AThreadSummary,
  listA2AInboxEnvelopes,
  listA2AInboxThreads,
  saveA2AEnvelope,
} from './store.js';
import {
  encodeForRegisteredTransport,
  type TransportRegistry,
  TransportRegistryError,
} from './transport-registry.js';

// Public server-side A2A runtime API required by roadmap #425.
// `false` is reserved for synchronous dispatch refusal before a durable outbox
// item exists; later outbox failures are audited and escalated asynchronously.
export type A2ADeliveryConfirmation =
  | {
      delivered: true;
      message_id: string;
      thread_id: string;
      recipient_agent_id: string;
    }
  | {
      delivered: 'pending';
      message_id: string;
      thread_id: string;
      recipient_agent_id: string;
    }
  | {
      delivered: false;
      message_id: string;
      thread_id: string;
      recipient_agent_id: string;
      failure_reason: string;
    };

export interface A2ASendMessageMeta {
  actor?: string;
  auditRole?: 'sender' | 'receiver';
  peerDescriptor?: unknown;
  transportRegistry?: TransportRegistry;
  sessionId?: string;
  auditRunId?: string;
  escalationTarget?: EscalationTarget;
}

let warnedMissingIdentityDiscoveryZone = false;

function deliveryConfirmation(
  delivered: true | 'pending',
  envelope: A2AEnvelope,
): A2ADeliveryConfirmation {
  return {
    delivered,
    message_id: envelope.id,
    thread_id: envelope.thread_id,
    recipient_agent_id: envelope.recipient_agent_id,
  };
}

function failedDeliveryConfirmation(
  envelope: A2AEnvelope,
  reason: string,
): A2ADeliveryConfirmation {
  return {
    delivered: false,
    message_id: envelope.id,
    thread_id: envelope.thread_id,
    recipient_agent_id: envelope.recipient_agent_id,
    failure_reason: reason,
  };
}

function warnIfIdentityDiscoveryDisabled(recipientAgentId: string): void {
  if (process.env[IDENTITY_DISCOVERY_ZONE_ENV]?.trim()) return;
  if (warnedMissingIdentityDiscoveryZone) return;
  warnedMissingIdentityDiscoveryZone = true;
  logger.warn(
    {
      recipientAgentId,
      env: IDENTITY_DISCOVERY_ZONE_ENV,
    },
    'A2A remote send queued without identity discovery configured',
  );
}

function recordSendAudits(params: {
  envelope: A2AEnvelope;
  meta?: A2ASendMessageMeta;
  transport: string;
  delivered?: boolean;
}): void {
  const auditBase = {
    envelope: params.envelope,
    sessionId: params.meta?.sessionId,
    runId: params.meta?.auditRunId,
    actor: params.meta?.actor,
    route: 'a2a.sendMessage',
    source: 'a2a-runtime',
    transport: params.transport,
  };
  if ((params.meta?.auditRole ?? 'sender') === 'sender') {
    recordA2AMessageAudit({
      type: 'a2a.send',
      ...auditBase,
    });
  }
  if (params.delivered) {
    recordA2AMessageAudit({
      type: 'a2a.deliver',
      ...auditBase,
    });
  }
  if (params.envelope.intent === 'handoff') {
    recordA2AMessageAudit({
      type: 'a2a.handoff',
      ...auditBase,
    });
  }
}

function assertInboxAgentId(agentId: string): void {
  if (!agentId.trim()) {
    throw new A2AEnvelopeValidationError(['agentId is required']);
  }
}

/**
 * Trusted in-process primitive for persisting an A2A envelope.
 * `actor` is audit metadata; sender authorization belongs at transport/tool boundaries.
 */
export function sendMessage(
  envelope: unknown,
  meta?: A2ASendMessageMeta,
): A2ADeliveryConfirmation {
  const peerDescriptor = normalizePeerDescriptor(meta?.peerDescriptor);
  const preparedEnvelope = attachA2AHandoffContext(
    validateA2AEnvelope(envelope),
  ) as A2AEnvelope;
  const normalizedEnvelope = resolveA2AEnvelopeAgentIds(preparedEnvelope);

  if (peerDescriptor.transport !== 'internal') {
    try {
      encodeForRegisteredTransport({
        envelope: normalizedEnvelope,
        peerDescriptor,
        registry: meta?.transportRegistry,
        sessionId: meta?.sessionId,
        runId: meta?.auditRunId,
        escalationTarget: meta?.escalationTarget,
      });
    } catch (error) {
      if (error instanceof TransportRegistryError) {
        return failedDeliveryConfirmation(normalizedEnvelope, error.message);
      }
      throw error;
    }
    recordSendAudits({
      envelope: normalizedEnvelope,
      meta,
      transport: peerDescriptor.transport,
    });
    return deliveryConfirmation('pending', normalizedEnvelope);
  }

  if (!isLocalA2AAgentId(normalizedEnvelope.recipient_agent_id)) {
    warnIfIdentityDiscoveryDisabled(normalizedEnvelope.recipient_agent_id);
    enqueueUnresolvedA2AEnvelope(
      normalizedEnvelope,
      normalizedEnvelope.recipient_agent_id,
      {
        sessionId: meta?.sessionId,
        runId: meta?.auditRunId,
        escalationTarget: meta?.escalationTarget,
      },
    );
    recordSendAudits({
      envelope: normalizedEnvelope,
      meta,
      transport: 'a2a',
    });
    return deliveryConfirmation('pending', normalizedEnvelope);
  }

  const deliveredEnvelope = saveA2AEnvelope(normalizedEnvelope, {
    actor: meta?.actor,
    route: 'a2a.sendMessage',
    source: 'a2a-runtime',
  });
  enqueueA2AInboxDispatch(deliveredEnvelope, {
    actor: meta?.actor,
    source:
      (meta?.auditRole ?? 'sender') === 'receiver'
        ? 'a2a.inbound'
        : 'a2a.runtime',
    sessionId: meta?.sessionId,
    runId: meta?.auditRunId,
  });
  recordSendAudits({
    envelope: deliveredEnvelope,
    meta,
    transport: peerDescriptor.transport,
    delivered: true,
  });
  return deliveryConfirmation(true, deliveredEnvelope);
}

/**
 * Returns all persisted envelopes received by `agentId`, sorted by `created_at`
 * and then id. Read/unread state and pagination are intentionally out of scope.
 */
export function inbox(agentId: string): A2AEnvelope[] {
  assertInboxAgentId(agentId);
  return listA2AInboxEnvelopes(agentId);
}

export function inboxThreads(agentId: string): A2AThreadSummary[] {
  assertInboxAgentId(agentId);
  return listA2AInboxThreads(agentId);
}
