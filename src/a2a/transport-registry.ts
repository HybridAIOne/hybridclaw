import { Buffer } from 'node:buffer';

import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import {
  createSuspendedSession,
  emitInteractionNeededEvent,
} from '../gateway/interactive-escalation.js';
import type { EscalationTarget } from '../types/execution.js';
import { a2aOutboundAdapter } from './a2a-outbound.js';
import {
  type A2AEnvelope,
  type A2AEnvelopeAuditSummary,
  summarizeA2AEnvelopeForAudit,
  validateA2AEnvelope,
} from './envelope.js';
import {
  type A2APeerTransport,
  isKnownPeerDescriptor,
  normalizePeerDescriptor,
  type PeerDescriptor,
} from './peer-descriptor.js';
import { webhookOutboundAdapter } from './webhook-outbound.js';

export interface TransportAdapterContext {
  sessionId?: string;
  runId?: string;
  escalationTarget?: EscalationTarget;
}

export interface TransportAdapter<WirePayload = unknown> {
  encode(
    envelope: A2AEnvelope,
    descriptor?: PeerDescriptor,
    context?: TransportAdapterContext,
  ): WirePayload;
  decode(payload: WirePayload, descriptor?: PeerDescriptor): A2AEnvelope;
}

export type TransportAdapters = Partial<
  Record<A2APeerTransport, TransportAdapter>
>;

export class TransportRegistryError extends Error {
  readonly transport: string;

  constructor(transport: string) {
    super(`No A2A transport adapter registered for "${transport}".`);
    this.name = 'TransportRegistryError';
    this.transport = transport;
  }
}

export const internalTransportAdapter: TransportAdapter<A2AEnvelope> = {
  encode(envelope) {
    return envelope;
  },
  decode(payload) {
    return validateA2AEnvelope(payload);
  },
};

export const DEFAULT_TRANSPORT_ADAPTERS: TransportAdapters = {
  internal: internalTransportAdapter,
  a2a: a2aOutboundAdapter,
  webhook: webhookOutboundAdapter,
};

export function resolveTransportAdapter(
  descriptor: PeerDescriptor,
  adapters: TransportAdapters = DEFAULT_TRANSPORT_ADAPTERS,
): TransportAdapter | null {
  return isKnownPeerDescriptor(descriptor)
    ? (adapters[descriptor.transport] ?? null)
    : null;
}

export interface TransportEscalationAuditInput {
  envelope: A2AEnvelope;
  transport: string;
  sessionId?: string;
  runId?: string;
  escalationTarget?: EscalationTarget;
}

function transportEscalationPrompt(params: {
  transport: string;
  summary: A2AEnvelopeAuditSummary;
}): string {
  return [
    `A2A transport escalation: no adapter is registered for "${params.transport}".`,
    params.summary.threadId ? `Thread: ${params.summary.threadId}` : '',
    params.summary.messageId ? `Message: ${params.summary.messageId}` : '',
    params.summary.senderAgentId
      ? `Sender: ${params.summary.senderAgentId}`
      : '',
    params.summary.recipientAgentId
      ? `Recipient: ${params.summary.recipientAgentId}`
      : '',
    'Reply `approved` after registering an adapter, or `declined` to cancel this delivery.',
  ]
    .filter(Boolean)
    .join('\n');
}

function createTransportEscalationSession(input: {
  transport: string;
  summary: A2AEnvelopeAuditSummary;
  escalationTarget?: EscalationTarget;
  runId: string;
  sessionId: string;
  approvalId: string;
}): void {
  const session = createSuspendedSession({
    sessionId: input.sessionId,
    approvalId: input.approvalId,
    prompt: transportEscalationPrompt(input),
    userId: input.escalationTarget?.recipient || 'operator',
    modality: 'push',
    expectedReturnKinds: ['approved', 'declined', 'timeout'],
    frameSnapshot: {
      url: 'hybridclaw://a2a/transport-registry',
      title: 'A2A transport adapter required',
    },
    context: {
      host: 'a2a.transport-registry',
      pageTitle: `Missing ${input.transport} transport adapter`,
    },
    skillId: 'a2a.transport-registry',
    escalationTarget: input.escalationTarget,
  });
  emitInteractionNeededEvent({
    session,
    runId: input.runId,
  });
}

const COMPOSITE_KEY_PART_PATTERN = /^[A-Za-z0-9._@-]{1,128}$/;

function encodeCompositeKeyPart(
  value: string | null | undefined,
  fallback: string,
): string {
  const raw = value?.trim() || fallback;
  if (COMPOSITE_KEY_PART_PATTERN.test(raw)) {
    return raw;
  }
  return Buffer.from(raw).toString('base64url');
}

function makeEscalationSessionId(summary: A2AEnvelopeAuditSummary): string {
  return `a2a:${encodeCompositeKeyPart(summary.threadId, 'sendMessage')}`;
}

function makeEscalationApprovalId(
  transport: string,
  summary: A2AEnvelopeAuditSummary,
): string {
  return [
    'a2a-transport',
    transport,
    encodeCompositeKeyPart(summary.messageId || summary.threadId, 'message'),
  ].join('-');
}

export function recordTransportEscalationAudit(
  input: TransportEscalationAuditInput,
): void {
  const summary = summarizeA2AEnvelopeForAudit(input.envelope);
  const sessionId = input.sessionId || makeEscalationSessionId(summary);
  const approvalId = makeEscalationApprovalId(input.transport, summary);
  const runId = input.runId || makeAuditRunId('a2a-transport');
  const action = `a2a.transport:${input.transport}`;
  const reason = `No registered A2A transport adapter for "${input.transport}".`;

  recordAuditEvent({
    sessionId,
    runId,
    event: {
      type: 'authorization.check',
      action,
      resource: 'a2a.transport-registry',
      allowed: false,
      reason,
      envelope: summary,
    },
  });

  recordAuditEvent({
    sessionId,
    runId,
    event: {
      type: 'escalation.decision',
      action,
      proposedAction: `send A2A envelope via ${input.transport} transport`,
      escalationRoute: 'approval_request',
      target: input.escalationTarget || null,
      stakes: 'high',
      classifier: 'a2a.transport-registry',
      classifierReasoning: [reason],
      approvalDecision: 'required',
      reason,
      envelope: summary,
    },
  });

  recordAuditEvent({
    sessionId,
    runId,
    event: {
      type: 'approval.request',
      action,
      description: reason,
      policyName: 'a2a-transport-registry',
      envelope: summary,
    },
  });

  createTransportEscalationSession({
    transport: input.transport,
    summary,
    escalationTarget: input.escalationTarget,
    runId,
    sessionId,
    approvalId,
  });
}

export function encodeForRegisteredTransport(params: {
  envelope: unknown;
  peerDescriptor?: unknown;
  adapters?: TransportAdapters;
  sessionId?: string;
  runId?: string;
  escalationTarget?: EscalationTarget;
}): A2AEnvelope {
  const normalizedEnvelope = validateA2AEnvelope(params.envelope);
  const descriptor = normalizePeerDescriptor(params.peerDescriptor);
  const adapter = resolveTransportAdapter(descriptor, params.adapters);
  if (!adapter) {
    recordTransportEscalationAudit({
      envelope: normalizedEnvelope,
      transport: descriptor.transport,
      sessionId: params.sessionId,
      runId: params.runId,
      escalationTarget: params.escalationTarget,
    });
    throw new TransportRegistryError(descriptor.transport);
  }
  if (descriptor.transport === 'internal') {
    return validateA2AEnvelope(adapter.encode(normalizedEnvelope, descriptor));
  }

  adapter.encode(normalizedEnvelope, descriptor, {
    sessionId: params.sessionId,
    runId: params.runId,
    escalationTarget: params.escalationTarget,
  });
  return normalizedEnvelope;
}
