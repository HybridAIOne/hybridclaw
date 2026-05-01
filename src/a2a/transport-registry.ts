import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import {
  createSuspendedSession,
  emitInteractionNeededEvent,
} from '../gateway/interactive-escalation.js';
import type { EscalationTarget } from '../types/execution.js';
import {
  type A2AEnvelope,
  A2AEnvelopeValidationError,
  validateA2AEnvelope,
} from './envelope.js';
import {
  type A2APeerTransport,
  isKnownPeerDescriptor,
  type KnownPeerDescriptor,
  normalizePeerDescriptor,
} from './peer-descriptor.js';

export interface TransportAdapter<WirePayload = unknown> {
  readonly transport: A2APeerTransport;
  encode(envelope: A2AEnvelope, descriptor?: KnownPeerDescriptor): WirePayload;
  decode(payload: WirePayload, descriptor?: KnownPeerDescriptor): A2AEnvelope;
}

export class TransportRegistryError extends Error {
  readonly transport: string;

  constructor(transport: string) {
    super(`No A2A transport adapter registered for "${transport}".`);
    this.name = 'TransportRegistryError';
    this.transport = transport;
  }
}

export class TransportRegistry {
  private readonly adapters = new Map<string, TransportAdapter>();

  register(adapter: TransportAdapter): void {
    this.adapters.set(adapter.transport, adapter);
  }

  resolveByTransport(transport: string): TransportAdapter | null {
    const normalized = transport.trim().toLowerCase();
    return this.adapters.get(normalized) ?? null;
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

export const internalTransportAdapter: TransportAdapter<A2AEnvelope> = {
  transport: 'internal',
  encode(envelope) {
    return validateA2AEnvelope(envelope);
  },
  decode(payload) {
    return validateA2AEnvelope(payload);
  },
};

export function createDefaultTransportRegistry(): TransportRegistry {
  const registry = new TransportRegistry();
  registry.register(internalTransportAdapter);
  return registry;
}

export const defaultTransportRegistry = createDefaultTransportRegistry();

export interface TransportEscalationAuditInput {
  envelope: unknown;
  transport: string;
  sessionId?: string;
  runId?: string;
  escalationTarget?: EscalationTarget;
}

function summarizeEnvelopeForAudit(envelope: unknown): {
  messageId: string | null;
  threadId: string | null;
  senderAgentId: string | null;
  recipientAgentId: string | null;
} {
  try {
    const normalized = validateA2AEnvelope(envelope);
    return {
      messageId: normalized.id,
      threadId: normalized.thread_id,
      senderAgentId: normalized.sender_agent_id,
      recipientAgentId: normalized.recipient_agent_id,
    };
  } catch {
    return {
      messageId: null,
      threadId: null,
      senderAgentId: null,
      recipientAgentId: null,
    };
  }
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
}): void {
  const sessionId = [
    'a2a-transport',
    input.transport,
    input.summary.threadId || 'thread',
    input.summary.messageId || 'message',
  ].join(':');
  const session = createSuspendedSession({
    sessionId,
    approvalId: [
      'a2a-transport',
      input.transport,
      input.summary.messageId || Date.now().toString(36),
    ].join('-'),
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

export function recordTransportEscalationAudit(
  input: TransportEscalationAuditInput,
): void {
  const summary = summarizeEnvelopeForAudit(input.envelope);
  const sessionId =
    input.sessionId ||
    (summary.threadId ? `a2a:${summary.threadId}` : 'a2a:sendMessage');
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
  if (!isKnownPeerDescriptor(descriptor)) {
    throw new TransportRegistryError(descriptor.transport);
  }

  const encoded = adapter.encode(normalizedEnvelope, descriptor);
  if (descriptor.transport !== 'internal') {
    throw new A2AEnvelopeValidationError([
      `transport ${descriptor.transport} has no delivery implementation`,
    ]);
  }
  return validateA2AEnvelope(encoded);
}
