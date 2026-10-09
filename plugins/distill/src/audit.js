import { recordAuditEvent } from '@hybridaione/hybridclaw/plugin-sdk';

/**
 * F2 provenance: every distill lifecycle action lands in the hash-chained
 * audit trail under a per-subject session so a subject's full history is
 * discoverable (and erasable) as one identifier set.
 */
export function emitDistillAuditEvent(params) {
  recordAuditEvent({
    sessionId: `distill:${params.subject}`,
    runId: params.runId,
    event: {
      type: params.type,
      subject: params.subject,
      ...params.fields,
    },
  });
}
