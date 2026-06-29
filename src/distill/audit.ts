import { recordAuditEvent } from '../audit/audit-events.js';
import { logger } from '../logger.js';
import { initDatabase, isDatabaseInitialized } from '../memory/db.js';

let dbInitAttempted = false;

function ensureAuditDatabase(): void {
  if (dbInitAttempted) return;
  dbInitAttempted = true;
  try {
    if (!isDatabaseInitialized()) {
      initDatabase({ quiet: true });
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to initialize DB for distill audit events');
  }
}

/**
 * F2 provenance: every distill lifecycle action lands in the hash-chained
 * audit trail under a per-subject session so a subject's full history is
 * discoverable (and erasable) as one identifier set.
 */
export function emitDistillAuditEvent(params: {
  subject: string;
  runId: string;
  type: string;
  fields?: Record<string, unknown>;
}): void {
  ensureAuditDatabase();
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
