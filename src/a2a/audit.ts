import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import type { A2AEnvelope } from './envelope.js';
import { summarizeA2AEnvelopeForAudit } from './envelope.js';

export type A2AMessageAuditEventType =
  | 'a2a.send'
  | 'a2a.deliver'
  | 'a2a.handoff';

interface RecordA2AMessageAuditBaseInput {
  envelope: A2AEnvelope;
  sessionId?: string;
  runId?: string;
  actor?: string;
  route?: string;
  source?: string;
  transport?: string;
}

export type RecordA2AMessageAuditInput = RecordA2AMessageAuditBaseInput &
  (
    | {
        type: 'a2a.send' | 'a2a.handoff';
      }
    | {
        type: 'a2a.deliver';
        statusCode?: number;
        attempts?: number;
      }
  );

export function getA2AAuditSessionId(envelope: A2AEnvelope): string {
  return `a2a:thread:${envelope.thread_id}`;
}

function deliveryMetadata(
  input: RecordA2AMessageAuditInput,
): Record<string, unknown> {
  if (input.type !== 'a2a.deliver') return {};
  return {
    ...(input.statusCode !== undefined ? { statusCode: input.statusCode } : {}),
    ...(input.attempts !== undefined ? { attempts: input.attempts } : {}),
  };
}

export function recordA2AMessageAudit(input: RecordA2AMessageAuditInput): void {
  recordAuditEvent({
    sessionId: input.sessionId ?? getA2AAuditSessionId(input.envelope),
    runId: input.runId ?? makeAuditRunId('a2a-message'),
    event: {
      type: input.type,
      actor: input.actor ?? null,
      route: input.route ?? null,
      source: input.source ?? null,
      transport: input.transport ?? null,
      envelope: summarizeA2AEnvelopeForAudit(input.envelope),
      ...deliveryMetadata(input),
    },
  });
}
