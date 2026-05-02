import { Buffer } from 'node:buffer';

import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import {
  createSuspendedSession,
  emitInteractionNeededEvent,
} from '../gateway/interactive-escalation.js';
import type { EscalationTarget } from '../types/execution.js';
import { type A2AEnvelope, validateA2AEnvelope } from './envelope.js';
import {
  type A2APeerTransport,
  normalizePeerDescriptor,
  type PeerDescriptor,
} from './peer-descriptor.js';
import { A2A_TRANSPORT_PATTERN, normalizeTransportString } from './utils.js';

export interface TransportAdapter {
  readonly transport: A2APeerTransport;
  encode(envelope: A2AEnvelope, descriptor?: PeerDescriptor): A2AEnvelope;
}

export class TransportRegistryError extends Error {
  readonly transport: string;

  constructor(
    transport: string,
    message = `No A2A transport adapter registered for "${transport}".`,
  ) {
    super(message);
    this.name = 'TransportRegistryError';
    this.transport = transport;
  }
}

function normalizeAdapterTransport(transport: string): string {
  const normalized = normalizeTransportString(transport);
  if (!A2A_TRANSPORT_PATTERN.test(normalized)) {
    throw new TransportRegistryError(
      normalized || '<empty>',
      'A2A transport adapter keys must match /^[a-z][a-z0-9._-]{0,63}$/ after trimming and lowercasing.',
    );
  }
  return normalized;
}

export class TransportRegistry {
  private readonly adapters = new Map<string, TransportAdapter>();

  register(adapter: TransportAdapter): void {
    this.adapters.set(normalizeAdapterTransport(adapter.transport), adapter);
  }

  resolveByTransport(transport: string): TransportAdapter | null {
    return this.adapters.get(normalizeAdapterTransport(transport)) ?? null;
  }

  resolve(descriptor: unknown): {
    adapter: TransportAdapter | null;
    descriptor: ReturnType<typeof normalizePeerDescriptor>;
  } {
    const normalizedDescriptor = normalizePeerDescriptor(descriptor);
    return {
      adapter: this.resolveByTransport(normalizedDescriptor.transport),
      descriptor: normalizedDescriptor,
    };
  }
}

export const internalTransportAdapter: TransportAdapter = {
  transport: 'internal',
  encode(envelope) {
    return envelope;
  },
};

export function createDefaultTransportRegistry(): TransportRegistry {
  const registry = new TransportRegistry();
  registry.register(internalTransportAdapter);
  return registry;
}

const defaultTransportRegistry = createDefaultTransportRegistry();

export interface TransportEscalationAuditInput {
  envelope: A2AEnvelope;
  transport: string;
  sessionId?: string;
  runId?: string;
  escalationTarget?: EscalationTarget;
}

function summarizeEnvelopeForAudit(envelope: A2AEnvelope): {
  messageId: string | null;
  threadId: string | null;
  senderAgentId: string | null;
  recipientAgentId: string | null;
} {
  return {
    messageId: envelope.id,
    threadId: envelope.thread_id,
    senderAgentId: envelope.sender_agent_id,
    recipientAgentId: envelope.recipient_agent_id,
  };
}

function transportEscalationPrompt(params: {
  transport: string;
  summary: ReturnType<typeof summarizeEnvelopeForAudit>;
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
  summary: ReturnType<typeof summarizeEnvelopeForAudit>;
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

function makeEscalationSessionId(
  summary: ReturnType<typeof summarizeEnvelopeForAudit>,
): string {
  return `a2a:${encodeCompositeKeyPart(summary.threadId, 'sendMessage')}`;
}

function makeEscalationApprovalId(
  transport: string,
  summary: ReturnType<typeof summarizeEnvelopeForAudit>,
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
  const summary = summarizeEnvelopeForAudit(input.envelope);
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
  registry?: TransportRegistry;
  sessionId?: string;
  runId?: string;
  escalationTarget?: EscalationTarget;
}): A2AEnvelope {
  const normalizedEnvelope = validateA2AEnvelope(params.envelope);
  const registry = params.registry || defaultTransportRegistry;
  const { adapter, descriptor } = registry.resolve(params.peerDescriptor);
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
  if (descriptor.transport !== 'internal') {
    throw new TransportRegistryError(
      descriptor.transport,
      `A2A transport "${descriptor.transport}" has no delivery implementation.`,
    );
  }
  return adapter.encode(normalizedEnvelope, descriptor);
}
