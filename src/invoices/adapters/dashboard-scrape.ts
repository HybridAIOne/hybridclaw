import { INVOICE_SCRAPE_PLANS } from '../scrape-plans.js';
import type {
  InvoiceAdapter,
  InvoiceAdapterContext,
  InvoiceCredentials,
  InvoiceListOptions,
  InvoiceMeta,
  InvoiceProviderId,
} from '../types.js';
import {
  PlaywrightScrapeInvoiceDriver,
  type ScrapeInvoicePlan,
} from './playwright-scrape.js';

export interface ScrapeInvoiceDriver {
  login(
    credentials: InvoiceCredentials,
    context: InvoiceAdapterContext,
  ): Promise<void>;
  listInvoices(options: InvoiceListOptions): Promise<InvoiceMeta[]>;
  downloadInvoice(invoice: InvoiceMeta): Promise<Uint8Array>;
}

export class DashboardScrapeInvoiceAdapter
  implements InvoiceAdapter<ScrapeInvoiceDriver>
{
  readonly id: InvoiceProviderId;
  readonly displayName: string;
  readonly #driver?: ScrapeInvoiceDriver;
  readonly #loginUrl: string;

  constructor(options: {
    id: InvoiceProviderId;
    displayName: string;
    loginUrl: string;
    driver?: ScrapeInvoiceDriver;
  }) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.#loginUrl = options.loginUrl;
    this.#driver = options.driver;
  }

  async login(
    credentials: InvoiceCredentials,
    context: InvoiceAdapterContext,
  ): Promise<ScrapeInvoiceDriver> {
    if (!this.#driver) {
      throw new Error(
        `${this.displayName} invoice scraping requires a Playwright driver for ${this.#loginUrl}.`,
      );
    }
    await this.#driver.login(credentials, context);
    return this.#driver;
  }

  async listInvoices(
    session: ScrapeInvoiceDriver,
    options: InvoiceListOptions,
  ): Promise<InvoiceMeta[]> {
    return session.listInvoices(options);
  }

  async download(
    session: ScrapeInvoiceDriver,
    invoice: InvoiceMeta,
  ): Promise<Uint8Array> {
    return session.downloadInvoice(invoice);
  }
}

const SCRAPE_PROVIDER_DISPLAY_NAMES = {
  github: 'GitHub',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  atlassian: 'Atlassian',
  linkedin: 'LinkedIn Campaign Manager',
} satisfies Partial<Record<InvoiceProviderId, string>>;

function createScrapeInvoiceAdapter(
  id: keyof typeof SCRAPE_PROVIDER_DISPLAY_NAMES,
  options: { driver?: ScrapeInvoiceDriver } = {},
): DashboardScrapeInvoiceAdapter {
  const plan = INVOICE_SCRAPE_PLANS[id];
  if (!plan) {
    throw new Error(`Missing invoice scrape plan for ${id}.`);
  }
  return new DashboardScrapeInvoiceAdapter({
    id,
    displayName: SCRAPE_PROVIDER_DISPLAY_NAMES[id],
    loginUrl: plan.loginUrl,
    driver: options.driver,
  });
}

export function createGitHubInvoiceAdapter(
  options: { driver?: ScrapeInvoiceDriver } = {},
): DashboardScrapeInvoiceAdapter {
  return createScrapeInvoiceAdapter('github', options);
}

export function createOpenAIInvoiceAdapter(
  options: { driver?: ScrapeInvoiceDriver } = {},
): DashboardScrapeInvoiceAdapter {
  return createScrapeInvoiceAdapter('openai', options);
}

export function createAnthropicInvoiceAdapter(
  options: { driver?: ScrapeInvoiceDriver } = {},
): DashboardScrapeInvoiceAdapter {
  return createScrapeInvoiceAdapter('anthropic', options);
}

export function createAtlassianInvoiceAdapter(
  options: { driver?: ScrapeInvoiceDriver } = {},
): DashboardScrapeInvoiceAdapter {
  return createScrapeInvoiceAdapter('atlassian', options);
}

export function createLinkedInInvoiceAdapter(
  options: { driver?: ScrapeInvoiceDriver } = {},
): DashboardScrapeInvoiceAdapter {
  return createScrapeInvoiceAdapter('linkedin', options);
}

export function createPlaywrightScrapeDriver(
  plan: ScrapeInvoicePlan,
): ScrapeInvoiceDriver {
  return new PlaywrightScrapeInvoiceDriver(plan);
}
