const { createSign } = require('node:crypto');
const {
  invoiceIssuePeriod,
  isoDate,
  moneyFromDecimal,
  periodFromDate,
  vatRate,
} = require('../helpers/money.cjs');

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

const GCP_BILLING_DOCUMENTS_PLAN = {
  loginUrl: 'https://accounts.google.com/',
  documentsUrl: (billingAccountName) =>
    `https://console.cloud.google.com/billing/${encodeURIComponent(
      billingAccountName.replace(/^billingAccounts\//u, ''),
    )}/documents`,
  usernameSelector: 'input[type="email"]',
  passwordSelector: 'input[type="password"]',
  nextSelector: '#identifierNext, #passwordNext, button[type="submit"]',
  invoiceRowSelector:
    '[data-hc-provider="gcp"] [data-hc-invoice-row], [aria-label*="documents" i] tr, table tbody tr',
  invoiceNoSelector:
    '[data-hc-invoice-no], [data-column-key="documentNumber"], [data-field="documentNumber"], a[href*="documents"]',
  issueDateSelector:
    '[data-hc-issue-date], [data-column-key="issueDate"], [data-field="issueDate"], time',
  dueDateSelector:
    '[data-hc-due-date], [data-column-key="dueDate"], [data-field="dueDate"]',
  periodSelector:
    '[data-hc-period], [data-column-key="billingPeriod"], [data-field="billingPeriod"]',
  netSelector:
    '[data-hc-net], [data-column-key="subtotal"], [data-field="subtotal"]',
  vatSelector: '[data-hc-vat], [data-column-key="tax"], [data-field="tax"]',
  grossSelector:
    '[data-hc-gross], [data-column-key="total"], [data-field="total"]',
  currencySelector:
    '[data-hc-currency], [data-column-key="currency"], [data-column-key="total"], [data-field="total"]',
  pdfLinkSelector:
    'a[href*="download"], a[href*="documents"], a[download][href$=".pdf"]',
  headerAliases: {
    invoiceNo: ['document number', 'invoice number', 'number', 'rechnung'],
    issueDate: ['issue date', 'document date', 'date', 'datum'],
    dueDate: ['due date', 'payment due', 'fällig'],
    period: ['period', 'billing period', 'leistungszeitraum'],
    net: ['subtotal', 'net', 'amount before tax', 'netto'],
    vat: ['tax', 'vat', 'ust', 'mwst'],
    gross: ['total', 'amount due', 'gesamt', 'brutto'],
    currency: ['currency', 'total', 'amount due', 'währung'],
  },
};

class GcpInvoiceAdapter {
  id = 'gcp';
  displayName = 'GCP';
  requiredCredentials = ['billingAccountId'];

  constructor(options = {}) {
    this.fetch = options.fetch || fetch;
    this.cloudBillingEndpoint =
      options.cloudBillingEndpoint || 'https://cloudbilling.googleapis.com/v1';
    this.tokenEndpoint = options.tokenEndpoint || GOOGLE_TOKEN_ENDPOINT;
    this.documentDriver = options.documentDriver || null;
    this.unverifiedSelectors = Boolean(this.documentDriver);
  }

  async login(credentials, context = {}) {
    if (!credentials.billingAccountId) {
      throw new Error('GCP invoice adapter requires credentials.billingAccountId.');
    }
    const accessToken = await resolveGcpAccessToken({
      credentials,
      fetch: this.fetch,
      tokenEndpoint: this.tokenEndpoint,
    });
    const accountName = billingAccountName(credentials.billingAccountId);
    await this.cloudBillingJson({ accessToken }, `/${accountName}`);
    let documentSession = null;
    if (this.documentDriver) {
      documentSession = await this.documentDriver.login(
        { ...credentials, accessToken },
        { ...context, billingAccountId: accountName },
      );
    }
    return {
      accountName,
      credentials: { ...credentials, accessToken },
      documentSession,
    };
  }

  async listInvoices(session, options = {}) {
    if (!this.documentDriver || !session.documentSession) {
      throw new Error(
        'GCP invoice PDFs are not exposed by the public Cloud Billing REST API. Configure a browser documentDriver for the Cloud Billing Documents page.',
      );
    }
    const invoices = await this.documentDriver.listInvoices(session.documentSession, {
      ...options,
      billingAccountId: session.accountName,
    });
    return invoices.map((invoice) => {
      if (invoice.vendor === 'gcp') return invoice;
      return normalizeGcpInvoice(invoice, invoiceIssuePeriod(options));
    });
  }

  async download(session, invoice) {
    if (this.documentDriver?.downloadInvoice && session.documentSession) {
      return this.documentDriver.downloadInvoice(session.documentSession, invoice);
    }
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

  async close(session) {
    await this.documentDriver?.close?.(session.documentSession);
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

class PlaywrightGcpBillingDocumentsDriver {
  constructor(plan = GCP_BILLING_DOCUMENTS_PLAN) {
    this.plan = plan;
    this.context = null;
    this.page = null;
  }

  async login(credentials, context) {
    if (!context.profileDir) {
      throw new Error('GCP billing document browser driver requires context.profileDir.');
    }
    const playwright = await import('playwright');
    this.context = await playwright.chromium.launchPersistentContext(
      context.profileDir,
      { headless: true },
    );
    this.page = await this.context.newPage();
    if (credentials.username && credentials.password) {
      await this.page.goto(this.plan.loginUrl, { waitUntil: 'domcontentloaded' });
      await this.page.fill(this.plan.usernameSelector, credentials.username);
      await this.page.click(this.plan.nextSelector);
      await this.page.fill(this.plan.passwordSelector, credentials.password);
      await this.page.click(this.plan.nextSelector);
    }
    await this.page.goto(this.plan.documentsUrl(context.billingAccountId), {
      waitUntil: 'domcontentloaded',
    });
    return { page: this.page };
  }

  async listInvoices(session, options = {}) {
    const period = invoiceIssuePeriod(options);
    const invoices = await session.page.$$eval(
      this.plan.invoiceRowSelector,
      (rows, plan) => {
        const textContent = (root, selector) =>
          (root.querySelector(selector)?.textContent || '').trim();
        const tableFieldText = (row, field) => {
          const explicit = textContent(row, plan[`${field}Selector`]);
          if (explicit) return explicit;
          const table = row.closest('table');
          const headers = Array.from(
            table?.querySelectorAll('thead th, [role="columnheader"]') || [],
          ).map((header) =>
            (header.textContent || '').trim().toLowerCase().replace(/\s+/gu, ' '),
          );
          const aliases = plan.headerAliases[field] || [];
          const index = headers.findIndex((header) =>
            aliases.some((alias) => header.includes(alias)),
          );
          if (index < 0) return '';
          const cells = Array.from(row.querySelectorAll('td, [role="gridcell"]'));
          return (cells[index]?.textContent || '').trim();
        };
        return rows.map((row) => ({
          invoiceNumber: tableFieldText(row, 'invoiceNo'),
          issueDate: tableFieldText(row, 'issueDate'),
          dueDate: tableFieldText(row, 'dueDate'),
          servicePeriodStart: tableFieldText(row, 'period'),
          netAmount: tableFieldText(row, 'net'),
          taxAmount: tableFieldText(row, 'vat'),
          totalAmount: tableFieldText(row, 'gross'),
          currency: tableFieldText(row, 'currency'),
          pdfUrl: row.querySelector(plan.pdfLinkSelector)?.href || '',
        }));
      },
      this.plan,
    );
    return invoices.map((invoice) => normalizeGcpInvoice(invoice, period));
  }

  async downloadInvoice(_session, invoice) {
    const response = await this.page.goto(invoice.source_url, {
      waitUntil: 'domcontentloaded',
    });
    if (!response?.ok()) {
      throw new Error(
        `GCP invoice ${invoice.invoice_no} PDF download failed with HTTP ${
          response?.status() || 'unknown'
        }.`,
      );
    }
    return Buffer.from(await response.body());
  }

  async close() {
    await this.context?.close();
    this.context = null;
    this.page = null;
  }
}

async function resolveGcpAccessToken(input) {
  if (input.credentials.accessToken) return input.credentials.accessToken;
  if (
    input.credentials.refreshToken &&
    input.credentials.clientId &&
    input.credentials.clientSecret
  ) {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: input.credentials.refreshToken,
      client_id: input.credentials.clientId,
      client_secret: input.credentials.clientSecret,
    });
    return exchangeGoogleToken(input.fetch, input.tokenEndpoint, body);
  }
  if (input.credentials.serviceAccountEmail && input.credentials.privateKey) {
    const assertion = createGcpServiceAccountJwt({
      clientEmail: input.credentials.serviceAccountEmail,
      privateKey: input.credentials.privateKey,
      tokenEndpoint: input.tokenEndpoint,
    });
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    });
    return exchangeGoogleToken(input.fetch, input.tokenEndpoint, body);
  }
  throw new Error(
    'GCP invoice adapter requires accessToken, OAuth refresh-token credentials, or service-account credentials.',
  );
}

async function exchangeGoogleToken(fetchImpl, tokenEndpoint, body) {
  const response = await fetchImpl(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) {
    throw new Error(`GCP OAuth token exchange failed with HTTP ${response.status}.`);
  }
  const payload = await response.json();
  if (!payload.access_token) {
    throw new Error('GCP OAuth token response is missing access_token.');
  }
  return payload.access_token;
}

function createGcpServiceAccountJwt(input) {
  const now = Math.floor((input.now || Date.now()) / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: input.clientEmail,
    scope: input.scope || CLOUD_PLATFORM_SCOPE,
    aud: input.tokenEndpoint || GOOGLE_TOKEN_ENDPOINT,
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signature = createSign('RSA-SHA256')
    .update(unsigned)
    .sign(input.privateKey.replace(/\\n/gu, '\n'));
  return `${unsigned}.${base64Url(signature)}`;
}

function base64UrlJson(value) {
  return base64Url(Buffer.from(JSON.stringify(value), 'utf8'));
}

function base64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/gu, '')
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_');
}

function billingAccountName(value) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error('GCP invoice adapter requires billingAccountId.');
  return normalized.startsWith('billingAccounts/')
    ? normalized
    : `billingAccounts/${normalized}`;
}

function normalizeGcpInvoice(document, period) {
  const invoiceNo = String(
    document.invoice_no ||
      document.invoiceNumber ||
      document.documentNumber ||
      document.id ||
      document.name ||
      '',
  );
  if (!invoiceNo) throw new Error('GCP invoice document is missing invoice number.');
  const issueDate = isoDate(
    document.issue_date || document.issueDate || document.documentDate || document.createdAt,
    'issueDate',
  );
  const dueDate = isoDate(
    document.due_date || document.dueDate || document.paymentDueDate || issueDate,
    'dueDate',
  );
  const net = moneyFromDecimal(
    document.net ?? unwrapGcpAmount(document.subtotal || document.netAmount || document.amountBeforeTax),
  );
  const vat = moneyFromDecimal(
    document.vat ?? unwrapGcpAmount(document.taxAmount || document.vatAmount || document.totalTax),
  );
  const gross = moneyFromDecimal(
    document.gross ?? unwrapGcpAmount(document.totalAmount || document.amountDue || document.balanceDue),
  );
  const currency = String(
    document.currency ||
      document.currencyCode ||
      document.totalAmount?.currencyCode ||
      document.amountDue?.currencyCode ||
      '',
  ).toUpperCase();
  if (!/^[A-Z]{3}$/u.test(currency)) {
    throw new Error(`GCP invoice ${invoiceNo} is missing currency.`);
  }
  const pdfUrl = String(
    document.source_url ||
      document.pdfUrl ||
      document.downloadUrl ||
      document.pdfDownloadUrl ||
      '',
  );
  if (!pdfUrl) throw new Error(`GCP invoice ${invoiceNo} is missing PDF URL.`);
  return {
    vendor: 'gcp',
    invoice_no: invoiceNo,
    period: document.period
      ? String(document.period)
      : document.servicePeriodStart
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
  CLOUD_PLATFORM_SCOPE,
  GCP_BILLING_DOCUMENTS_PLAN,
  GcpInvoiceAdapter,
  PlaywrightGcpBillingDocumentsDriver,
  createGcpInvoiceAdapter: (options) => new GcpInvoiceAdapter(options),
  createGcpServiceAccountJwt,
  createPlaywrightGcpBillingDocumentsDriver: (plan) =>
    new PlaywrightGcpBillingDocumentsDriver(plan),
  resolveGcpAccessToken,
};
