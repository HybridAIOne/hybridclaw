import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import type { A2AEnvelope } from './envelope.js';
import { summarizeA2AEnvelopeForAudit } from './envelope.js';

export type A2AMessageAuditEventType =
  | 'a2a.send'
  | 'a2a.deliver'
  | 'a2a.handoff';

export interface RecordA2AMessageAuditInput {
  type: A2AMessageAuditEventType;
  envelope: A2AEnvelope;
  sessionId?: string;
  runId?: string;
  actor?: string;
  route?: string;
  source?: string;
  transport?: string;
  statusCode?: number;
  attempts?: number;
}

function defaultA2ASessionId(envelope: A2AEnvelope): string {
  return `a2a:thread:${envelope.thread_id}`;
}

export function recordA2AMessageAudit(input: RecordA2AMessageAuditInput): void {
  recordAuditEvent({
    sessionId: input.sessionId || defaultA2ASessionId(input.envelope),
    runId: input.runId || makeAuditRunId('a2a-message'),
    event: {
      type: input.type,
      actor: input.actor || null,
      route: input.route || null,
      source: input.source || null,
      transport: input.transport || null,
      envelope: summarizeA2AEnvelopeForAudit(input.envelope),
      ...(input.statusCode !== undefined
        ? { statusCode: input.statusCode }
        : {}),
      ...(input.attempts !== undefined ? { attempts: input.attempts } : {}),
    },
  });
}
