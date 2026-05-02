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
    assertGoogleAdsCredentials(credentials, [
      'accessToken',
      'developerToken',
      'customerId',
      'billingSetup',
    ]);
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
      headers: googleAdsHeaders(credentials),
    });
    if (!response.ok) {
      throw await googleAdsHttpError(response, 'Google Ads invoice list');
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

  async discoverBillingSetups(credentials) {
    assertGoogleAdsCredentials(credentials, [
      'accessToken',
      'developerToken',
      'customerId',
    ]);
    const customerId = credentials.customerId.replace(/-/g, '');
    const response = await this.fetch(
      `https://googleads.googleapis.com/${this.apiVersion}/customers/${customerId}/googleAds:search`,
      {
        method: 'POST',
        headers: googleAdsHeaders(credentials, {
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          query: [
            'SELECT',
            '  billing_setup.resource_name,',
            '  billing_setup.payments_account,',
            '  billing_setup.status',
            'FROM billing_setup',
          ].join('\n'),
        }),
      },
    );
    if (!response.ok) {
      throw await googleAdsHttpError(response, 'Google Ads billing setup discovery');
    }
    const payload = await response.json();
    return (payload.results || []).map((row) => {
      const billingSetup = row.billingSetup || {};
      return {
        resourceName: String(billingSetup.resourceName || ''),
        paymentsAccount: String(billingSetup.paymentsAccount || ''),
        status: String(billingSetup.status || ''),
      };
    });
  }

  async download(session, invoice) {
    const response = await this.fetch(invoice.source_url, {
      headers: googleAdsHeaders(session.credentials),
    });
    if (!response.ok) {
      throw await googleAdsHttpError(
        response,
        `Google Ads invoice ${invoice.invoice_no} PDF download`,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}

function assertGoogleAdsCredentials(credentials, keys) {
  for (const key of keys) {
    if (!credentials[key]) {
      throw new Error(`Google Ads invoice adapter requires credentials.${key}.`);
    }
  }
}

function googleAdsHeaders(credentials, extra = {}) {
  return {
    ...extra,
    Authorization: `Bearer ${credentials.accessToken}`,
    'developer-token': credentials.developerToken,
    ...(credentials.loginCustomerId
      ? { 'login-customer-id': credentials.loginCustomerId.replace(/-/g, '') }
      : {}),
  };
}

async function googleAdsHttpError(response, context) {
  let body = '';
  try {
    body = await response.text();
  } catch {
    body = '';
  }
  const requestId = response.headers?.get?.('request-id');
  const details = [
    `${context} failed with HTTP ${response.status}.`,
    requestId ? `request-id: ${requestId}.` : '',
    body ? `Response body: ${truncateGoogleAdsErrorBody(body)}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return new Error(details);
}

function truncateGoogleAdsErrorBody(body) {
  const normalized = body.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 4000) return normalized;
  return `${normalized.slice(0, 4000)}...`;
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
