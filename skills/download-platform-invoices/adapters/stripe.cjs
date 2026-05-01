const { periodFromDate, sinceTimestamp } = require('../helpers/money.cjs');

function dateFromUnixSeconds(value, fieldName, invoiceNo) {
  if (!value) throw new Error(`Stripe invoice ${invoiceNo} is missing ${fieldName}.`);
  return new Date(value * 1000).toISOString().slice(0, 10);
}

function cents(value) {
  return Math.round(value || 0) / 100;
}

function taxAmount(invoice) {
  if (typeof invoice.tax === 'number') return invoice.tax;
  return (invoice.total_tax_amounts || []).reduce(
    (total, entry) => total + (entry.amount || 0),
    0,
  );
}

class StripeInvoiceAdapter {
  id = 'stripe';
  displayName = 'Stripe';

  constructor(options = {}) {
    this.fetch = options.fetch || fetch;
    this.apiBaseUrl = options.apiBaseUrl || 'https://api.stripe.com/v1';
  }

  async login(credentials) {
    if (!credentials.apiKey) {
      throw new Error('Stripe invoice adapter requires credentials.apiKey.');
    }
    return { apiKey: credentials.apiKey };
  }

  async listInvoices(session, options = {}) {
    const url = new URL(`${this.apiBaseUrl}/invoices`);
    url.searchParams.set('limit', '100');
    url.searchParams.set('status', 'paid');
    const sinceTime = sinceTimestamp(options, 'Stripe invoice since date');
    if (sinceTime != null) {
      url.searchParams.set('created[gte]', String(Math.floor(sinceTime / 1000)));
    }
    const response = await this.fetch(url, {
      headers: { Authorization: `Bearer ${session.apiKey}` },
    });
    if (!response.ok) {
      throw new Error(`Stripe invoice list failed with HTTP ${response.status}.`);
    }
    const payload = await response.json();
    return (payload.data || []).map(mapStripeInvoice);
  }

  async download(session, invoice) {
    const response = await this.fetch(invoice.source_url, {
      headers: { Authorization: `Bearer ${session.apiKey}` },
    });
    if (!response.ok) {
      throw new Error(
        `Stripe invoice ${invoice.invoice_no} PDF download failed with HTTP ${response.status}.`,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}

function mapStripeInvoice(invoice) {
  const invoiceNo = invoice.number || invoice.id || '';
  if (!invoiceNo) throw new Error('Stripe invoice is missing both number and id.');
  const sourceUrl = invoice.invoice_pdf || invoice.hosted_invoice_url || '';
  if (!sourceUrl) {
    throw new Error(`Stripe invoice ${invoiceNo} does not include a PDF URL.`);
  }
  const net = cents(invoice.amount_subtotal ?? invoice.subtotal);
  const vat = cents(taxAmount(invoice));
  const gross = cents(invoice.amount_paid ?? invoice.amount_due);
  return {
    vendor: 'stripe',
    invoice_no: invoiceNo,
    period: periodFromDate(
      dateFromUnixSeconds(
        invoice.period_start || invoice.created,
        'period_start or created',
        invoiceNo,
      ),
    ),
    issue_date: dateFromUnixSeconds(invoice.created, 'created', invoiceNo),
    due_date: dateFromUnixSeconds(
      invoice.due_date || invoice.created,
      'due_date or created',
      invoiceNo,
    ),
    net,
    vat_rate: net > 0 ? Number((vat / net).toFixed(4)) : 0,
    vat,
    gross,
    currency: (invoice.currency || 'usd').toUpperCase(),
    source_url: sourceUrl,
  };
}

module.exports = { StripeInvoiceAdapter };
