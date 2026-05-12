function makeAuditRunId(prefix) {
  return `${prefix}-${Date.now().toString(36)}`;
}

function emitInvoiceFetchedAudit(input) {
  const recordAudit = input.recordAudit || (() => undefined);
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

module.exports = { emitInvoiceFetchedAudit, makeAuditRunId };
