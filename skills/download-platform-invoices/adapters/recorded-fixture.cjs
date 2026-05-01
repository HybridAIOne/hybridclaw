const fs = require('node:fs');
const { sinceTimestamp } = require('../helpers/money.cjs');

class RecordedFixtureInvoiceAdapter {
  constructor(options) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.fixture = parseRecordedInvoiceFixture(options.fixturePath);
  }

  async login() {
    return { fixture: this.fixture };
  }

  async listInvoices(session, options = {}) {
    const since = sinceTimestamp(options, 'recorded invoice since date');
    return session.fixture.invoices
      .filter((invoice) => {
        if (since == null) return true;
        return new Date(invoice.issue_date).getTime() >= since;
      })
      .map(({ pdf_base64: _pdfBase64, ...invoice }) => invoice);
  }

  async download(session, invoice) {
    const fixtureInvoice = session.fixture.invoices.find(
      (entry) =>
        entry.vendor === invoice.vendor && entry.invoice_no === invoice.invoice_no,
    );
    if (!fixtureInvoice) {
      throw new Error(
        `Recorded invoice ${invoice.vendor}:${invoice.invoice_no} was not found.`,
      );
    }
    return Buffer.from(fixtureInvoice.pdf_base64, 'base64');
  }
}

function parseRecordedInvoiceFixture(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (error) {
    throw new Error(`Invalid recorded invoice fixture at ${filePath}: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.invoices)) {
    throw new Error(`Invalid recorded invoice fixture at ${filePath}.`);
  }
  if (
    !parsed.recorded_session ||
    typeof parsed.recorded_session !== 'object' ||
    !Array.isArray(parsed.recorded_session.steps) ||
    parsed.recorded_session.steps.length === 0 ||
    !parsed.recorded_session.evidence ||
    typeof parsed.recorded_session.evidence !== 'object'
  ) {
    throw new Error(
      `Invalid recorded invoice fixture at ${filePath}: missing recorded_session evidence.`,
    );
  }
  return parsed;
}

module.exports = { RecordedFixtureInvoiceAdapter, parseRecordedInvoiceFixture };
