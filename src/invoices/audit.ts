import {
  makeAuditRunId,
  type RecordAuditEventInput,
  recordAuditEvent,
} from '../audit/audit-events.js';
import type { InvoiceRecord } from './types.js';

export type InvoiceAuditRecorder = (input: RecordAuditEventInput) => void;

export function emitInvoiceFetchedAudit(input: {
  sessionId: string;
  runId?: string;
  record: InvoiceRecord;
  recordAudit?: InvoiceAuditRecorder;
}): void {
  const recordAudit = input.recordAudit || recordAuditEvent;
  recordAudit({
    sessionId: input.sessionId,
    runId: input.runId || makeAuditRunId('invoice'),
    event: {
      type: 'invoice.fetched',
      vendor: input.record.vendor,
      invoice_no: input.record.invoice_no,
      period: input.record.period,
      issue_date: input.record.issue_date,
      gross: input.record.gross,
      currency: input.record.currency,
      pdf_path: input.record.pdf_path,
      source_url: input.record.source_url,
      checksum_sha256: input.record.checksum_sha256,
    },
  });
}
