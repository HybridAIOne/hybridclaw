import type {
  InvoiceAdapter,
  InvoiceAdapterContext,
  InvoiceCredentials,
  InvoiceListOptions,
  InvoiceMeta,
} from '../types.js';

type FetchLike = typeof fetch;

interface StripeInvoice {
  id?: string;
  number?: string | null;
  created?: number;
  due_date?: number | null;
  period_start?: number | null;
  period_end?: number | null;
  amount_due?: number | null;
  amount_paid?: number | null;
  amount_subtotal?: number | null;
  subtotal?: number | null;
  tax?: number | null;
  total_tax_amounts?: Array<{ amount?: number | null }>;
  currency?: string | null;
  invoice_pdf?: string | null;
  hosted_invoice_url?: string | null;
}

interface StripeInvoiceListResponse {
  data?: StripeInvoice[];
}

interface StripeSession {
  apiKey: string;
}

function dateFromUnixSeconds(value: number | null | undefined): string {
  if (!value) return new Date().toISOString().slice(0, 10);
  return new Date(value * 1000).toISOString().slice(0, 10);
}

function periodFromInvoice(invoice: StripeInvoice): string {
  const periodStart = invoice.period_start || invoice.created;
  return dateFromUnixSeconds(periodStart).slice(0, 7);
}

function cents(value: number | null | undefined): number {
  return Math.round(value || 0) / 100;
}

function taxAmount(invoice: StripeInvoice): number {
  if (typeof invoice.tax === 'number') return invoice.tax;
  return (invoice.total_tax_amounts || []).reduce(
    (total, entry) => total + (entry.amount || 0),
    0,
  );
}

function mapStripeInvoice(invoice: StripeInvoice): InvoiceMeta {
  const invoiceNo = invoice.number || invoice.id || '';
  if (!invoiceNo) {
    throw new Error('Stripe invoice is missing both number and id.');
  }

  const net = cents(invoice.amount_subtotal ?? invoice.subtotal);
  const vat = cents(taxAmount(invoice));
  const gross = cents(invoice.amount_paid ?? invoice.amount_due);
  const vatRate = net > 0 ? Number((vat / net).toFixed(4)) : 0;
  const sourceUrl = invoice.invoice_pdf || invoice.hosted_invoice_url || '';
  if (!sourceUrl) {
    throw new Error(`Stripe invoice ${invoiceNo} does not include a PDF URL.`);
  }

  return {
    vendor: 'stripe',
    invoice_no: invoiceNo,
    period: periodFromInvoice(invoice),
    issue_date: dateFromUnixSeconds(invoice.created),
    due_date: dateFromUnixSeconds(invoice.due_date || invoice.created),
    net,
    vat_rate: vatRate,
    vat,
    gross,
    currency: (invoice.currency || 'usd').toUpperCase(),
    source_url: sourceUrl,
    suggested_file_name: `${invoiceNo}.pdf`,
  };
}

export class StripeInvoiceAdapter implements InvoiceAdapter<StripeSession> {
  readonly id = 'stripe' as const;
  readonly displayName = 'Stripe';
  readonly #fetch: FetchLike;
  readonly #apiBaseUrl: string;

  constructor(options: { fetch?: FetchLike; apiBaseUrl?: string } = {}) {
    this.#fetch = options.fetch || fetch;
    this.#apiBaseUrl = options.apiBaseUrl || 'https://api.stripe.com/v1';
  }

  async login(
    credentials: InvoiceCredentials,
    _context: InvoiceAdapterContext,
  ): Promise<StripeSession> {
    if (!credentials.apiKey) {
      throw new Error('Stripe invoice adapter requires credentials.apiKey.');
    }
    return { apiKey: credentials.apiKey };
  }

  async listInvoices(
    session: StripeSession,
    options: InvoiceListOptions,
  ): Promise<InvoiceMeta[]> {
    const url = new URL(`${this.#apiBaseUrl}/invoices`);
    url.searchParams.set('limit', '100');
    url.searchParams.set('status', 'paid');
    if (options.since) {
      url.searchParams.set(
        'created[gte]',
        String(Math.floor(new Date(options.since).getTime() / 1000)),
      );
    }

    const response = await this.#fetch(url, {
      headers: {
        Authorization: `Bearer ${session.apiKey}`,
      },
    });
    if (!response.ok) {
      throw new Error(
        `Stripe invoice list failed with HTTP ${response.status}.`,
      );
    }
    const payload = (await response.json()) as StripeInvoiceListResponse;
    return (payload.data || []).map(mapStripeInvoice);
  }

  async download(
    session: StripeSession,
    invoice: InvoiceMeta,
  ): Promise<Uint8Array> {
    const response = await this.#fetch(invoice.source_url, {
      headers: {
        Authorization: `Bearer ${session.apiKey}`,
      },
    });
    if (!response.ok) {
      throw new Error(
        `Stripe invoice ${invoice.invoice_no} PDF download failed with HTTP ${response.status}.`,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}
