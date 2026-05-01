import fs from 'node:fs';

import type {
  InvoiceAdapter,
  InvoiceAdapterContext,
  InvoiceCredentials,
  InvoiceListOptions,
  InvoiceMeta,
  InvoiceProviderId,
} from '../types.js';

interface RecordedInvoiceFixture {
  provider: InvoiceProviderId | string;
  invoices: Array<InvoiceMeta & { pdf_base64: string }>;
}

interface RecordedInvoiceSession {
  fixture: RecordedInvoiceFixture;
}

function parseRecordedInvoiceFixture(filePath: string): RecordedInvoiceFixture {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid recorded invoice fixture at ${filePath}.`);
  }
  const fixture = parsed as Partial<RecordedInvoiceFixture>;
  if (
    typeof fixture.provider !== 'string' ||
    !Array.isArray(fixture.invoices)
  ) {
    throw new Error(`Invalid recorded invoice fixture at ${filePath}.`);
  }
  return {
    provider: fixture.provider,
    invoices: fixture.invoices,
  };
}

export class RecordedFixtureInvoiceAdapter
  implements InvoiceAdapter<RecordedInvoiceSession>
{
  readonly id: InvoiceProviderId | string;
  readonly displayName: string;
  readonly #fixturePath: string;

  constructor(options: {
    id: InvoiceProviderId | string;
    displayName: string;
    fixturePath: string;
  }) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.#fixturePath = options.fixturePath;
  }

  async login(
    _credentials: InvoiceCredentials,
    _context: InvoiceAdapterContext,
  ): Promise<RecordedInvoiceSession> {
    return { fixture: parseRecordedInvoiceFixture(this.#fixturePath) };
  }

  async listInvoices(
    session: RecordedInvoiceSession,
    options: InvoiceListOptions,
  ): Promise<InvoiceMeta[]> {
    const since = options.since ? new Date(options.since).getTime() : null;
    return session.fixture.invoices
      .filter((invoice) => {
        if (since == null) return true;
        return new Date(invoice.issue_date).getTime() >= since;
      })
      .map(({ pdf_base64: _pdfBase64, ...invoice }) => invoice);
  }

  async download(
    session: RecordedInvoiceSession,
    invoice: InvoiceMeta,
  ): Promise<Uint8Array> {
    const fixtureInvoice = session.fixture.invoices.find(
      (entry) =>
        entry.vendor === invoice.vendor &&
        entry.invoice_no === invoice.invoice_no,
    );
    if (!fixtureInvoice) {
      throw new Error(
        `Recorded invoice ${invoice.vendor}:${invoice.invoice_no} was not found.`,
      );
    }
    return Buffer.from(fixtureInvoice.pdf_base64, 'base64');
  }
}
