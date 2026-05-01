const { parseInvoiceMoneyText, sinceTimestamp } = require('../helpers/money.cjs');
const { generateTotp } = require('../helpers/totp.cjs');

const tablePlan = {
  invoiceRowSelector: '[data-hc-invoice-row], table tbody tr',
  invoiceNoSelector: '[data-hc-invoice-no], td:nth-child(1)',
  issueDateSelector: '[data-hc-issue-date], td:nth-child(2)',
  dueDateSelector: '[data-hc-due-date], td:nth-child(3)',
  periodSelector: '[data-hc-period], td:nth-child(4)',
  netSelector: '[data-hc-net], td:nth-child(5)',
  vatSelector: '[data-hc-vat], td:nth-child(6)',
  grossSelector: '[data-hc-gross], td:nth-child(7)',
  currencySelector: '[data-hc-currency], td:nth-child(8)',
  pdfLinkSelector: 'a[href*="invoice"], a[href$=".pdf"]',
};

const totpSelector =
  'input[autocomplete="one-time-code"], input[name*="totp" i], input[name*="otp" i]';

const INVOICE_SCRAPE_PLANS = {
  github: {
    loginUrl: 'https://github.com/login',
    billingUrl: 'https://github.com/settings/billing/summary',
    usernameSelector: 'input[name="login"]',
    passwordSelector: 'input[name="password"]',
    submitSelector: 'input[type="submit"], button[type="submit"]',
    totpSelector,
    captchaSelector: '[data-testid="captcha"], iframe[src*="captcha"]',
    ...tablePlan,
  },
  openai: {
    loginUrl: 'https://platform.openai.com/login',
    billingUrl: 'https://platform.openai.com/account/billing',
    usernameSelector: 'input[name="email"], input[type="email"]',
    passwordSelector: 'input[name="password"], input[type="password"]',
    submitSelector: 'button[type="submit"]',
    totpSelector,
    captchaSelector: '[data-testid="captcha"], iframe[src*="captcha"]',
    ...tablePlan,
  },
  anthropic: {
    loginUrl: 'https://console.anthropic.com/login',
    billingUrl: 'https://console.anthropic.com/settings/billing',
    usernameSelector: 'input[name="email"], input[type="email"]',
    passwordSelector: 'input[name="password"], input[type="password"]',
    submitSelector: 'button[type="submit"]',
    totpSelector,
    captchaSelector: '[data-testid="captcha"], iframe[src*="captcha"]',
    ...tablePlan,
  },
  atlassian: {
    loginUrl: 'https://id.atlassian.com/login',
    billingUrl: 'https://my.atlassian.com/billing',
    usernameSelector: 'input[name="username"], input[type="email"]',
    passwordSelector: 'input[name="password"], input[type="password"]',
    submitSelector: 'button[type="submit"]',
    totpSelector,
    captchaSelector: '[data-testid="captcha"], iframe[src*="captcha"]',
    ...tablePlan,
  },
  linkedin: {
    loginUrl: 'https://www.linkedin.com/login',
    billingUrl: 'https://www.linkedin.com/campaignmanager/accounts',
    usernameSelector: 'input[name="session_key"]',
    passwordSelector: 'input[name="session_password"]',
    submitSelector: 'button[type="submit"]',
    totpSelector,
    captchaSelector: '[data-test-id="captcha"], iframe[src*="captcha"]',
    ...tablePlan,
  },
  gcp: {
    loginUrl: 'https://accounts.google.com/',
    billingUrl: 'https://console.cloud.google.com/billing/documents',
    usernameSelector: 'input[type="email"]',
    passwordSelector: 'input[type="password"]',
    submitSelector: 'button[type="submit"], #identifierNext, #passwordNext',
    totpSelector,
    captchaSelector: 'iframe[src*="captcha"], [aria-label*="captcha" i]',
    ...tablePlan,
  },
};

class DashboardScrapeInvoiceAdapter {
  constructor(options) {
    const plan = INVOICE_SCRAPE_PLANS[options.id];
    if (!plan) throw new Error(`Missing invoice scrape plan for ${options.id}.`);
    this.id = options.id;
    this.displayName = options.displayName;
    this.loginUrl = plan.loginUrl;
    this.driver = options.driver;
  }

  async login(credentials, context) {
    if (!this.driver) {
      throw new Error(
        `${this.displayName} invoice scraping requires a Playwright driver for ${this.loginUrl}.`,
      );
    }
    await this.driver.login(credentials, context);
    return this.driver;
  }

  async listInvoices(session, options) {
    return session.listInvoices(options);
  }

  async download(session, invoice) {
    return session.downloadInvoice(invoice);
  }
}

class PlaywrightScrapeInvoiceDriver {
  constructor(plan) {
    this.plan = plan;
    this.context = null;
    this.page = null;
    this.providerId = null;
  }

  async login(credentials, context) {
    if (!context.profileDir) {
      throw new Error('Scrape invoice adapters require context.profileDir.');
    }
    this.providerId = context.providerId;
    if (!credentials.username || !credentials.password) {
      throw new Error('Scrape invoice adapters require username and password.');
    }

    const playwright = await import('playwright');
    this.context = await playwright.chromium.launchPersistentContext(
      context.profileDir,
      { headless: true },
    );
    this.page = await this.context.newPage();
    await this.page.goto(this.plan.loginUrl, { waitUntil: 'domcontentloaded' });
    await this.page.fill(this.plan.usernameSelector, credentials.username);
    await this.page.fill(this.plan.passwordSelector, credentials.password);
    await this.page.click(this.plan.submitSelector);
    if (this.plan.captchaSelector) {
      try {
        await this.page.waitForSelector(this.plan.captchaSelector, {
          timeout: 1000,
        });
        throw new Error(
          'Captcha detected during invoice portal login; operator escalation required.',
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes('operator escalation required')
        ) {
          throw error;
        }
      }
    }
    if (this.plan.totpSelector && credentials.totpSecret) {
      await this.page.waitForSelector(this.plan.totpSelector);
      await this.page.fill(this.plan.totpSelector, generateTotp(credentials.totpSecret));
      await this.page.click(this.plan.submitSelector);
    }
    await this.page.goto(this.plan.billingUrl, { waitUntil: 'domcontentloaded' });
  }

  async listInvoices(options = {}) {
    if (!this.page) throw new Error('Scrape invoice session is not logged in.');
    const evaluationPlan = {
      ...this.plan,
      vendor: this.providerId || new URL(this.plan.billingUrl).hostname,
    };
    const invoices = await this.page.$$eval(
      this.plan.invoiceRowSelector,
      (rows, plan) => {
        const textContent = (root, selector) =>
          (root.querySelector(selector)?.textContent || '').trim();
        const numberFromText = (value) => {
          const compact = value.replace(/[^0-9,.-]/g, '');
          if (!/\d/u.test(compact)) {
            throw new Error(`Unable to parse invoice money value: ${value}`);
          }
          const parsed = Number.parseFloat(
            compact.replace(/\.(?=\d{3}(?:[,.]|$))/g, '').replace(',', '.'),
          );
          if (!Number.isFinite(parsed)) {
            throw new Error(`Unable to parse invoice money value: ${value}`);
          }
          return parsed;
        };
        const currencyFromText = (value) => {
          const upper = value.toUpperCase();
          const match = upper.match(/\b[A-Z]{3}\b/u);
          if (match?.[0]) return match[0];
          if (upper.includes('€')) return 'EUR';
          if (upper.includes('$')) return 'USD';
          throw new Error(`Unable to parse invoice currency value: ${value}`);
        };
        return rows.map((row) => {
          const invoiceNo = textContent(row, plan.invoiceNoSelector);
          const net = numberFromText(textContent(row, plan.netSelector));
          const vat = numberFromText(textContent(row, plan.vatSelector));
          const gross = numberFromText(textContent(row, plan.grossSelector));
          return {
            vendor: plan.vendor,
            invoice_no: invoiceNo,
            period: textContent(row, plan.periodSelector),
            issue_date: textContent(row, plan.issueDateSelector),
            due_date: textContent(row, plan.dueDateSelector),
            net,
            vat_rate: net > 0 ? Number((vat / net).toFixed(4)) : 0,
            vat,
            gross,
            currency: currencyFromText(textContent(row, plan.currencySelector)),
            source_url:
              row.querySelector(plan.pdfLinkSelector)?.href || plan.billingUrl,
          };
        });
      },
      evaluationPlan,
    );
    const since = sinceTimestamp(options, 'scrape invoice since date');
    return invoices.filter((invoice) => {
      if (since == null) return true;
      return new Date(invoice.issue_date).getTime() >= since;
    });
  }

  async downloadInvoice(invoice) {
    if (!this.page) throw new Error('Scrape invoice session is not logged in.');
    const result = await this.page.evaluate(
      async (_invoiceNo, params) => {
        let url;
        try {
          url = new URL(params.sourceUrl, window.location.href);
        } catch {
          return { base64: '', contentType: '', status: 0 };
        }
        if (url.protocol !== 'https:' || !params.allowedHosts.includes(url.hostname)) {
          return { base64: '', contentType: 'blocked-url', status: 0 };
        }
        const response = await fetch(url.href);
        const contentType = response.headers.get('content-type') || '';
        if (
          !response.ok ||
          (contentType &&
            !contentType.toLowerCase().includes('pdf') &&
            !contentType.toLowerCase().includes('octet-stream'))
        ) {
          return { base64: '', contentType, status: response.status };
        }
        const buffer = await response.arrayBuffer();
        let binary = '';
        const bytes = new Uint8Array(buffer);
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return { base64: btoa(binary), contentType, status: response.status };
      },
      invoice.invoice_no,
      {
        sourceUrl: invoice.source_url,
        allowedHosts: Array.from(
          new Set([
            new URL(this.plan.loginUrl).hostname,
            new URL(this.plan.billingUrl).hostname,
          ]),
        ),
      },
    );
    if (!result.base64) {
      throw new Error(
        `Invoice PDF download failed for ${invoice.invoice_no}: HTTP ${
          result.status || 'unknown'
        } ${result.contentType || 'unknown content type'}.`,
      );
    }
    return Buffer.from(result.base64, 'base64');
  }

  async close() {
    await this.context?.close();
    this.context = null;
    this.page = null;
  }
}

function createScrapeAdapter(id, displayName, options = {}) {
  return new DashboardScrapeInvoiceAdapter({
    id,
    displayName,
    driver: options.driver,
  });
}

module.exports = {
  DashboardScrapeInvoiceAdapter,
  INVOICE_SCRAPE_PLANS,
  PlaywrightScrapeInvoiceDriver,
  createAnthropicInvoiceAdapter: (options) =>
    createScrapeAdapter('anthropic', 'Anthropic', options),
  createAtlassianInvoiceAdapter: (options) =>
    createScrapeAdapter('atlassian', 'Atlassian', options),
  createGcpInvoiceAdapter: (options) => createScrapeAdapter('gcp', 'GCP', options),
  createGitHubInvoiceAdapter: (options) =>
    createScrapeAdapter('github', 'GitHub', options),
  createLinkedInInvoiceAdapter: (options) =>
    createScrapeAdapter('linkedin', 'LinkedIn Campaign Manager', options),
  createOpenAIInvoiceAdapter: (options) =>
    createScrapeAdapter('openai', 'OpenAI', options),
  createPlaywrightScrapeDriver: (plan) => new PlaywrightScrapeInvoiceDriver(plan),
  parseInvoiceMoneyText,
};
