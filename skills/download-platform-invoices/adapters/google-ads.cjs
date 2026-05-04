const {
  invoiceIssuePeriod,
  moneyFromMicros,
  periodFromDate,
  vatRate,
} = require('../helpers/money.cjs');

class GoogleAdsInvoiceAdapter {
  id = 'google-ads';
  displayName = 'Google Ads';
  requiredCredentials = [
    'accessToken',
    'developerToken',
    'customerId',
    'billingSetup',
  ];

  constructor(options = {}) {
    this.fetch = options.fetch || fetch;
    this.apiVersion = options.apiVersion || 'v20';
  }

  async login(credentials) {
    for (const key of ['accessToken', 'developerToken', 'customerId', 'billingSetup']) {
      if (!credentials[key]) {
        throw new Error(`Google Ads invoice adapter requires credentials.${key}.`);
      }
    }
    return { credentials };
  }

  async listInvoices(session, options = {}) {
    const { credentials } = session;
    const period = invoiceIssuePeriod(options);
    const customerId = credentials.customerId.replace(/-/g, '');
    const url = new URL(
      `https://googleads.googleapis.com/${this.apiVersion}/customers/${customerId}/invoices`,
    );
    url.searchParams.set('billingSetup', credentials.billingSetup);
    url.searchParams.set('issueYear', String(period.year));
    url.searchParams.set('issueMonth', period.googleAdsMonth);
    const response = await this.fetch(url, {
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        'developer-token': credentials.developerToken,
        ...(credentials.loginCustomerId
          ? { 'login-customer-id': credentials.loginCustomerId }
          : {}),
      },
    });
    if (!response.ok) {
      throw new Error(`Google Ads invoice list failed with HTTP ${response.status}.`);
    }
    const payload = await response.json();
    return (payload.invoices || []).map((invoice) => {
      const invoiceNo = String(invoice.id || invoice.resourceName || '');
      if (!invoiceNo) throw new Error('Google Ads invoice is missing id.');
      const issueDate = formatGoogleAdsDate(invoice.issueDate, 'issue_date');
      const dueDate = formatGoogleAdsDate(invoice.dueDate, 'due_date');
      const serviceDateRange = invoice.serviceDateRange || {};
      const net = moneyFromMicros(invoice.subtotalAmountMicros);
      const vat = moneyFromMicros(invoice.taxAmountMicros);
      const gross = moneyFromMicros(invoice.totalAmountMicros);
      const sourceUrl = String(invoice.pdfUrl || '');
      if (!sourceUrl) {
        throw new Error(`Google Ads invoice ${invoiceNo} is missing pdfUrl.`);
      }
      const currency = String(invoice.currencyCode || credentials.currency || '');
      if (!/^[A-Z]{3}$/u.test(currency)) {
        throw new Error(`Google Ads invoice ${invoiceNo} is missing currencyCode.`);
      }
      return {
        vendor: 'google-ads',
        invoice_no: invoiceNo,
        period: serviceDateRange.startDate
          ? formatGoogleAdsDate(serviceDateRange.startDate, 'service start').slice(
              0,
              7,
            )
          : periodFromDate(issueDate),
        issue_date: issueDate,
        due_date: dueDate,
        net,
        vat_rate: vatRate(net, vat),
        vat,
        gross,
        currency,
        source_url: sourceUrl,
      };
    });
  }

  async download(session, invoice) {
    const response = await this.fetch(invoice.source_url, {
      headers: {
        Authorization: `Bearer ${session.credentials.accessToken}`,
        'developer-token': session.credentials.developerToken,
      },
    });
    if (!response.ok) {
      throw new Error(
        `Google Ads invoice ${invoice.invoice_no} PDF download failed with HTTP ${response.status}.`,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}

function formatGoogleAdsDate(value, fieldName) {
  if (typeof value === 'string') return value.slice(0, 10);
  if (value && typeof value === 'object') {
    const year = Number(value.year);
    const month = Number(value.month);
    const day = Number(value.day);
    if (year && month && day) {
      return `${year.toString().padStart(4, '0')}-${month
        .toString()
        .padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
    }
  }
  throw new Error(`Google Ads invoice is missing ${fieldName}.`);
}

module.exports = {
  GoogleAdsInvoiceAdapter,
  createGoogleAdsInvoiceAdapter: (options) =>
    new GoogleAdsInvoiceAdapter(options),
};
