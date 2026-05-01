const { parseInvoiceMoneyText, sinceTimestamp } = require('../helpers/money.cjs');
const { generateTotp } = require('../helpers/totp.cjs');
const {
  createCaptchaEscalation,
  createPushMfaEscalation,
} = require('../helpers/escalation.cjs');

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
    pushMfaSelector: '[data-testid="two-factor-app"], .two-factor-app, #webauthn-form',
    invoiceRowSelector:
      '[data-hc-provider="github"] [data-hc-invoice-row], [data-testid="billing-history-row"], [data-targets*="billing"] tr, table[aria-label*="billing" i] tbody tr',
    invoiceNoSelector:
      '[data-hc-invoice-no], [data-testid="invoice-number"], a[href*="/settings/billing/history/"], td:nth-of-type(1)',
    issueDateSelector:
      '[data-hc-issue-date], [datetime], relative-time, td:nth-of-type(2)',
    dueDateSelector:
      '[data-hc-due-date], [data-testid="due-date"], td:nth-of-type(3)',
    periodSelector:
      '[data-hc-period], [data-testid="billing-period"], td:nth-of-type(4)',
    netSelector: '[data-hc-net], [data-testid="subtotal"], td:nth-of-type(5)',
    vatSelector: '[data-hc-vat], [data-testid="tax"], td:nth-of-type(6)',
    grossSelector: '[data-hc-gross], [data-testid="total"], td:nth-of-type(7)',
    currencySelector:
      '[data-hc-currency], [data-testid="currency"], [data-testid="total"], td:nth-of-type(7)',
    pdfLinkSelector:
      'a[href*="/settings/billing/history/"], a[href*="invoice"], a[href$=".pdf"]',
  },
  openai: {
    loginUrl: 'https://platform.openai.com/login',
    billingUrl: 'https://platform.openai.com/account/billing',
    usernameSelector: 'input[name="email"], input[type="email"]',
    passwordSelector: 'input[name="password"], input[type="password"]',
    submitSelector: 'button[type="submit"]',
    totpSelector,
    captchaSelector: '[data-testid="captcha"], iframe[src*="captcha"]',
    pushMfaSelector:
      '[data-testid*="mfa" i], [data-testid*="challenge" i], input[name="code"]',
    invoiceRowSelector:
      '[data-hc-provider="openai"] [data-hc-invoice-row], [data-testid="invoice-row"], [data-testid="billing-history-row"], div[role="row"][data-testid*="invoice" i]',
    invoiceNoSelector:
      '[data-hc-invoice-no], [data-testid="invoice-number"], [data-testid="invoice-id"], [role="gridcell"]:nth-of-type(1)',
    issueDateSelector:
      '[data-hc-issue-date], [data-testid="invoice-date"], time, [role="gridcell"]:nth-of-type(2)',
    dueDateSelector:
      '[data-hc-due-date], [data-testid="due-date"], [role="gridcell"]:nth-of-type(3)',
    periodSelector:
      '[data-hc-period], [data-testid="invoice-period"], [role="gridcell"]:nth-of-type(4)',
    netSelector:
      '[data-hc-net], [data-testid="invoice-subtotal"], [role="gridcell"]:nth-of-type(5)',
    vatSelector:
      '[data-hc-vat], [data-testid="invoice-tax"], [role="gridcell"]:nth-of-type(6)',
    grossSelector:
      '[data-hc-gross], [data-testid="invoice-total"], [role="gridcell"]:nth-of-type(7)',
    currencySelector:
      '[data-hc-currency], [data-testid="invoice-currency"], [data-testid="invoice-total"], [role="gridcell"]:nth-of-type(7)',
    pdfLinkSelector:
      'a[href*="/account/billing/invoice"], a[href*="invoice"], a[href$=".pdf"]',
  },
  anthropic: {
    loginUrl: 'https://console.anthropic.com/login',
    billingUrl: 'https://console.anthropic.com/settings/billing',
    usernameSelector: 'input[name="email"], input[type="email"]',
    passwordSelector: 'input[name="password"], input[type="password"]',
    submitSelector: 'button[type="submit"]',
    totpSelector,
    captchaSelector: '[data-testid="captcha"], iframe[src*="captcha"]',
    pushMfaSelector:
      '[data-testid*="mfa" i], [data-testid*="challenge" i], input[name="code"]',
    invoiceRowSelector:
      '[data-hc-provider="anthropic"] [data-hc-invoice-row], [data-testid="invoice-row"], [data-testid="billing-history-row"], div[role="row"][data-testid*="invoice" i]',
    invoiceNoSelector:
      '[data-hc-invoice-no], [data-testid="invoice-number"], [data-testid="invoice-id"], [role="gridcell"]:nth-of-type(1)',
    issueDateSelector:
      '[data-hc-issue-date], [data-testid="invoice-date"], time, [role="gridcell"]:nth-of-type(2)',
    dueDateSelector:
      '[data-hc-due-date], [data-testid="due-date"], [role="gridcell"]:nth-of-type(3)',
    periodSelector:
      '[data-hc-period], [data-testid="billing-period"], [role="gridcell"]:nth-of-type(4)',
    netSelector:
      '[data-hc-net], [data-testid="subtotal"], [role="gridcell"]:nth-of-type(5)',
    vatSelector: '[data-hc-vat], [data-testid="tax"], [role="gridcell"]:nth-of-type(6)',
    grossSelector:
      '[data-hc-gross], [data-testid="total"], [role="gridcell"]:nth-of-type(7)',
    currencySelector:
      '[data-hc-currency], [data-testid="currency"], [data-testid="total"], [role="gridcell"]:nth-of-type(7)',
    pdfLinkSelector:
      'a[href*="/settings/billing"], a[href*="invoice"], a[href$=".pdf"]',
  },
  atlassian: {
    loginUrl: 'https://id.atlassian.com/login',
    billingUrl: 'https://my.atlassian.com/billing',
    usernameSelector: 'input[name="username"], input[type="email"]',
    passwordSelector: 'input[name="password"], input[type="password"]',
    submitSelector: 'button[type="submit"]',
    totpSelector,
    captchaSelector: '[data-testid="captcha"], iframe[src*="captcha"]',
    pushMfaSelector:
      '[data-testid*="mfa" i], [data-testid*="two-step" i], input[name="verificationCode"]',
    invoiceRowSelector:
      '[data-hc-provider="atlassian"] [data-hc-invoice-row], [data-testid="invoice-row"], [data-testid="billing-history-row"], table[data-testid*="invoice" i] tbody tr',
    invoiceNoSelector:
      '[data-hc-invoice-no], [data-testid="invoice-number"], a[href*="invoice"], td:nth-of-type(2)',
    issueDateSelector:
      '[data-hc-issue-date], [data-testid="invoice-date"], time, td:nth-of-type(1)',
    dueDateSelector:
      '[data-hc-due-date], [data-testid="due-date"], td:nth-of-type(3)',
    periodSelector:
      '[data-hc-period], [data-testid="billing-period"], td:nth-of-type(4)',
    netSelector: '[data-hc-net], [data-testid="subtotal"], td:nth-of-type(5)',
    vatSelector: '[data-hc-vat], [data-testid="tax"], td:nth-of-type(6)',
    grossSelector: '[data-hc-gross], [data-testid="total"], td:nth-of-type(7)',
    currencySelector:
      '[data-hc-currency], [data-testid="currency"], [data-testid="total"], td:nth-of-type(7)',
    pdfLinkSelector:
      'a[href*="invoice"], a[href*="billing"], a[download][href$=".pdf"]',
  },
  linkedin: {
    loginUrl: 'https://www.linkedin.com/login',
    billingUrl: 'https://www.linkedin.com/campaignmanager/accounts',
    usernameSelector: 'input[name="session_key"]',
    passwordSelector: 'input[name="session_password"]',
    submitSelector: 'button[type="submit"]',
    totpSelector,
    captchaSelector: '[data-test-id="captcha"], iframe[src*="captcha"]',
    pushMfaSelector:
      '[data-test-id*="challenge" i], [data-test-id*="mfa" i], input[name="pin"]',
    invoiceRowSelector:
      '[data-hc-provider="linkedin"] [data-hc-invoice-row], [data-test-id="billing-history-row"], [data-control-name*="invoice" i], table tbody tr',
    invoiceNoSelector:
      '[data-hc-invoice-no], [data-test-id="invoice-number"], a[href*="invoice"], td:nth-of-type(1)',
    issueDateSelector:
      '[data-hc-issue-date], [data-test-id="invoice-date"], time, td:nth-of-type(2)',
    dueDateSelector:
      '[data-hc-due-date], [data-test-id="due-date"], td:nth-of-type(3)',
    periodSelector:
      '[data-hc-period], [data-test-id="billing-period"], td:nth-of-type(4)',
    netSelector: '[data-hc-net], [data-test-id="subtotal"], td:nth-of-type(5)',
    vatSelector: '[data-hc-vat], [data-test-id="tax"], td:nth-of-type(6)',
    grossSelector: '[data-hc-gross], [data-test-id="total"], td:nth-of-type(7)',
    currencySelector:
      '[data-hc-currency], [data-test-id="currency"], [data-test-id="total"], td:nth-of-type(7)',
    pdfLinkSelector:
      'a[href*="invoice"], a[href*="billing"], a[download][href$=".pdf"]',
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
    this.requiredCredentials = ['username', 'password'];
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
    await this.detectEscalationBlockers();
    if (this.plan.totpSelector && credentials.totpSecret) {
      await this.page.waitForSelector(this.plan.totpSelector);
      await this.page.fill(this.plan.totpSelector, generateTotp(credentials.totpSecret));
      await this.page.click(this.plan.submitSelector);
      await this.detectEscalationBlockers();
    }
    await this.page.goto(this.plan.billingUrl, { waitUntil: 'domcontentloaded' });
  }

  async detectEscalationBlockers() {
    if (!this.page || !this.providerId) return;
    if (
      this.plan.captchaSelector &&
      (await selectorAppears(this.page, this.plan.captchaSelector))
    ) {
      throw createCaptchaEscalation(this.providerId, this.plan.captchaSelector);
    }
    if (
      this.plan.pushMfaSelector &&
      (await selectorAppears(this.page, this.plan.pushMfaSelector))
    ) {
      throw createPushMfaEscalation(this.providerId, this.plan.pushMfaSelector);
    }
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

async function selectorAppears(page, selector) {
  try {
    await page.waitForSelector(selector, { timeout: 1000 });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  DashboardScrapeInvoiceAdapter,
  INVOICE_SCRAPE_PLANS,
  PlaywrightScrapeInvoiceDriver,
  createAnthropicInvoiceAdapter: (options) =>
    createScrapeAdapter('anthropic', 'Anthropic', options),
  createAtlassianInvoiceAdapter: (options) =>
    createScrapeAdapter('atlassian', 'Atlassian', options),
  createGitHubInvoiceAdapter: (options) =>
    createScrapeAdapter('github', 'GitHub', options),
  createLinkedInInvoiceAdapter: (options) =>
    createScrapeAdapter('linkedin', 'LinkedIn Campaign Manager', options),
  createOpenAIInvoiceAdapter: (options) =>
    createScrapeAdapter('openai', 'OpenAI', options),
  createPlaywrightScrapeDriver: (plan) => new PlaywrightScrapeInvoiceDriver(plan),
  parseInvoiceMoneyText,
};
