const {
  invoiceIssuePeriod,
  isoDate,
  moneyFromDecimal,
  periodFromDate,
  vatRate,
} = require('../helpers/money.cjs');

class AzureInvoiceAdapter {
  id = 'azure';
  displayName = 'Azure';
  requiredCredentials = ['accessToken', 'billingAccountId'];

  constructor(options = {}) {
    this.fetch = options.fetch || fetch;
    this.apiVersion = options.apiVersion || '2024-04-01';
  }

  async login(credentials) {
    for (const key of ['accessToken', 'billingAccountId']) {
      if (!credentials[key]) {
        throw new Error(`Azure invoice adapter requires credentials.${key}.`);
      }
    }
    return { credentials };
  }

  async listInvoices(session, options = {}) {
    const period = invoiceIssuePeriod(options);
    const url = new URL(
      `https://management.azure.com/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(
        session.credentials.billingAccountId,
      )}/invoices`,
    );
    url.searchParams.set('api-version', this.apiVersion);
    url.searchParams.set('periodStartDate', period.startDate);
    url.searchParams.set('periodEndDate', period.endDate);
    const response = await this.fetch(url, {
      headers: { Authorization: `Bearer ${session.credentials.accessToken}` },
    });
    if (!response.ok) throw new Error(`Azure invoice list failed with HTTP ${response.status}.`);
    const payload = await response.json();
    return (payload.value || []).map((invoice) => {
      const props = invoice.properties || invoice;
      const invoiceNo = String(invoice.name || props.invoiceName || props.id || '');
      if (!invoiceNo) throw new Error('Azure invoice payload is missing name.');
      const net = moneyFromDecimal(unwrapAzureAmount(props.subTotal || props.subtotal || props.amountDue));
      const vat = moneyFromDecimal(unwrapAzureAmount(props.taxAmount || props.totalTax));
      const gross = moneyFromDecimal(unwrapAzureAmount(props.totalAmount || props.amountDue));
      const currency = String(props.currency || props.currencyCode || session.credentials.currency || '');
      if (!/^[A-Z]{3}$/u.test(currency)) {
        throw new Error(`Azure invoice ${invoiceNo} is missing currency.`);
      }
      return {
        vendor: 'azure',
        invoice_no: invoiceNo,
        period: periodFromDate(
          isoDate(props.billingPeriodStartDate || props.invoiceDate, 'billingPeriodStartDate'),
        ),
        issue_date: isoDate(props.invoiceDate, 'invoiceDate'),
        due_date: isoDate(props.dueDate || props.invoiceDate, 'dueDate'),
        net,
        vat_rate: vatRate(net, vat),
        vat,
        gross,
        currency,
        source_url: azureDownloadUrl(session.credentials.billingAccountId, invoiceNo, this.apiVersion),
      };
    });
  }

  async download(session, invoice) {
    const response = await this.fetch(invoice.source_url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.credentials.accessToken}` },
    });
    if (!response.ok) {
      throw new Error(`Azure invoice ${invoice.invoice_no} download URL failed with HTTP ${response.status}.`);
    }
    const payload = await response.json();
    const downloadUrl = String(payload.url || payload.downloadUrl || payload.properties?.downloadUrl || '');
    if (!downloadUrl) {
      throw new Error(`Azure invoice ${invoice.invoice_no} response is missing downloadUrl.`);
    }
    const pdfResponse = await this.fetch(downloadUrl);
    if (!pdfResponse.ok) {
      throw new Error(`Azure invoice ${invoice.invoice_no} PDF download failed with HTTP ${pdfResponse.status}.`);
    }
    return new Uint8Array(await pdfResponse.arrayBuffer());
  }
}

function unwrapAzureAmount(value) {
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    if (typeof value.value === 'string' || typeof value.value === 'number') return value.value;
    if (typeof value.amount === 'string' || typeof value.amount === 'number') return value.amount;
  }
  return undefined;
}

function azureDownloadUrl(billingAccountId, invoiceName, apiVersion) {
  const url = new URL(
    `https://management.azure.com/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(
      billingAccountId,
    )}/invoices/${encodeURIComponent(invoiceName)}/download`,
  );
  url.searchParams.set('api-version', apiVersion);
  return url.href;
}

module.exports = {
  AzureInvoiceAdapter,
  createAzureInvoiceAdapter: (options) => new AzureInvoiceAdapter(options),
};
