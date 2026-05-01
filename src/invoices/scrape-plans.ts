import type { ScrapeInvoicePlan } from './adapters/playwright-scrape.js';
import type { InvoiceProviderId } from './types.js';

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
} satisfies Pick<
  ScrapeInvoicePlan,
  | 'invoiceRowSelector'
  | 'invoiceNoSelector'
  | 'issueDateSelector'
  | 'dueDateSelector'
  | 'periodSelector'
  | 'netSelector'
  | 'vatSelector'
  | 'grossSelector'
  | 'currencySelector'
  | 'pdfLinkSelector'
>;

export const INVOICE_SCRAPE_PLANS: Partial<
  Record<InvoiceProviderId, ScrapeInvoicePlan>
> = {
  github: {
    loginUrl: 'https://github.com/login',
    billingUrl: 'https://github.com/settings/billing/summary',
    usernameSelector: 'input[name="login"]',
    passwordSelector: 'input[name="password"]',
    submitSelector: 'input[type="submit"], button[type="submit"]',
    captchaSelector: '[data-testid="captcha"], iframe[src*="captcha"]',
    ...tablePlan,
  },
  openai: {
    loginUrl: 'https://platform.openai.com/login',
    billingUrl: 'https://platform.openai.com/account/billing',
    usernameSelector: 'input[name="email"], input[type="email"]',
    passwordSelector: 'input[name="password"], input[type="password"]',
    submitSelector: 'button[type="submit"]',
    captchaSelector: '[data-testid="captcha"], iframe[src*="captcha"]',
    ...tablePlan,
  },
  anthropic: {
    loginUrl: 'https://console.anthropic.com/login',
    billingUrl: 'https://console.anthropic.com/settings/billing',
    usernameSelector: 'input[name="email"], input[type="email"]',
    passwordSelector: 'input[name="password"], input[type="password"]',
    submitSelector: 'button[type="submit"]',
    captchaSelector: '[data-testid="captcha"], iframe[src*="captcha"]',
    ...tablePlan,
  },
  atlassian: {
    loginUrl: 'https://id.atlassian.com/login',
    billingUrl: 'https://my.atlassian.com/billing',
    usernameSelector: 'input[name="username"], input[type="email"]',
    passwordSelector: 'input[name="password"], input[type="password"]',
    submitSelector: 'button[type="submit"]',
    captchaSelector: '[data-testid="captcha"], iframe[src*="captcha"]',
    ...tablePlan,
  },
  linkedin: {
    loginUrl: 'https://www.linkedin.com/login',
    billingUrl: 'https://www.linkedin.com/campaignmanager/accounts',
    usernameSelector: 'input[name="session_key"]',
    passwordSelector: 'input[name="session_password"]',
    submitSelector: 'button[type="submit"]',
    captchaSelector: '[data-test-id="captcha"], iframe[src*="captcha"]',
    ...tablePlan,
  },
};
