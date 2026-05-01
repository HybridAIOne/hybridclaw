const {
  invoiceIssuePeriod,
  isoDate,
  moneyFromDecimal,
  periodFromDate,
  vatRate,
} = require('../helpers/money.cjs');

class GcpInvoiceAdapter {
  id = 'gcp';
  displayName = 'GCP';
  requiredCredentials = ['accessToken', 'billingAccountId'];

  constructor(options = {}) {
    this.fetch = options.fetch || fetch;
    this.cloudBillingEndpoint =
      options.cloudBillingEndpoint || 'https://cloudbilling.googleapis.com/v1';
    this.documentEndpoint = options.documentEndpoint;
  }

  async login(credentials) {
    for (const key of this.requiredCredentials) {
      if (!credentials[key]) {
        throw new Error(`GCP invoice adapter requires credentials.${key}.`);
      }
    }
    return { credentials };
  }

  async listInvoices(session, options = {}) {
    const accountName = billingAccountName(session.credentials.billingAccountId);
    await this.cloudBillingJson(session.credentials, `/${accountName}`);
    const period = invoiceIssuePeriod(options);
    const payload = await this.listBillingDocuments(session.credentials, {
      accountName,
      period,
    });
    return extractGcpDocuments(payload)
      .filter((document) => isInvoiceDocument(document))
      .map((document) => normalizeGcpInvoice(document, period));
  }

  async download(session, invoice) {
    const response = await this.fetch(invoice.source_url, {
      headers: { Authorization: `Bearer ${session.credentials.accessToken}` },
    });
    if (!response.ok) {
      throw new Error(
        `GCP invoice ${invoice.invoice_no} PDF download failed with HTTP ${response.status}.`,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async listBillingDocuments(credentials, input) {
    const configuredUrl = credentials.documentIndexUrl || this.documentEndpoint;
    if (configuredUrl) {
      const url = new URL(configuredUrl);
      url.searchParams.set('billingAccount', input.accountName);
      url.searchParams.set('issueYear', String(input.period.year));
      url.searchParams.set('issueMonth', String(input.period.month).padStart(2, '0'));
      const response = await this.fetch(url, {
        headers: { Authorization: `Bearer ${credentials.accessToken}` },
      });
      if (!response.ok) {
        throw new Error(`GCP billing document list failed with HTTP ${response.status}.`);
      }
      return response.json();
    }

    throw new Error(
      'GCP Cloud Billing REST API exposes billing accounts but not invoice document downloads. Configure credentials.documentIndexUrl for a Google-authenticated billing document export or use the recorded/browser handoff path.',
    );
  }

  async cloudBillingJson(credentials, resourcePath) {
    const url = new URL(`${this.cloudBillingEndpoint}${resourcePath}`);
    const response = await this.fetch(url, {
      headers: { Authorization: `Bearer ${credentials.accessToken}` },
    });
    if (!response.ok) {
      throw new Error(`GCP Cloud Billing API request failed with HTTP ${response.status}.`);
    }
    return response.json();
  }
}

function billingAccountName(value) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error('GCP invoice adapter requires billingAccountId.');
  return normalized.startsWith('billingAccounts/')
    ? normalized
    : `billingAccounts/${normalized}`;
}

function extractGcpDocuments(payload) {
  if (Array.isArray(payload?.documents)) return payload.documents;
  if (Array.isArray(payload?.invoices)) return payload.invoices;
  if (Array.isArray(payload?.billingDocuments)) return payload.billingDocuments;
  throw new Error('GCP billing document response is missing documents.');
}

function isInvoiceDocument(document) {
  const type = String(document.type || document.documentType || 'invoice').toLowerCase();
  return type.includes('invoice') || type.includes('tax');
}

function normalizeGcpInvoice(document, period) {
  const invoiceNo = String(
    document.invoiceNumber || document.documentNumber || document.id || document.name || '',
  );
  if (!invoiceNo) throw new Error('GCP invoice document is missing invoice number.');
  const issueDate = isoDate(
    document.issueDate || document.documentDate || document.createdAt,
    'issueDate',
  );
  const dueDate = isoDate(document.dueDate || document.paymentDueDate || issueDate, 'dueDate');
  const net = moneyFromDecimal(
    unwrapGcpAmount(document.subtotal || document.netAmount || document.amountBeforeTax),
  );
  const vat = moneyFromDecimal(
    unwrapGcpAmount(document.taxAmount || document.vatAmount || document.totalTax),
  );
  const gross = moneyFromDecimal(
    unwrapGcpAmount(document.totalAmount || document.amountDue || document.balanceDue),
  );
  const currency = String(
    document.currencyCode ||
      document.currency ||
      document.totalAmount?.currencyCode ||
      document.amountDue?.currencyCode ||
      '',
  ).toUpperCase();
  if (!/^[A-Z]{3}$/u.test(currency)) {
    throw new Error(`GCP invoice ${invoiceNo} is missing currency.`);
  }
  const pdfUrl = String(
    document.pdfUrl || document.downloadUrl || document.pdfDownloadUrl || '',
  );
  if (!pdfUrl) throw new Error(`GCP invoice ${invoiceNo} is missing PDF URL.`);
  return {
    vendor: 'gcp',
    invoice_no: invoiceNo,
    period: document.servicePeriodStart
      ? periodFromDate(isoDate(document.servicePeriodStart, 'servicePeriodStart'))
      : `${period.year.toString().padStart(4, '0')}-${String(period.month).padStart(2, '0')}`,
    issue_date: issueDate,
    due_date: dueDate,
    net,
    vat_rate: vatRate(net, vat),
    vat,
    gross,
    currency,
    source_url: pdfUrl,
  };
}

function unwrapGcpAmount(value) {
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    if (typeof value.value === 'string' || typeof value.value === 'number') {
      return value.value;
    }
    if (typeof value.units === 'string' || typeof value.units === 'number') {
      const units = Number(value.units);
      const nanos = Number(value.nanos || 0);
      return units + nanos / 1_000_000_000;
    }
    if (typeof value.amount === 'string' || typeof value.amount === 'number') {
      return value.amount;
    }
  }
  return undefined;
}

module.exports = {
  GcpInvoiceAdapter,
  createGcpInvoiceAdapter: (options) => new GcpInvoiceAdapter(options),
};
