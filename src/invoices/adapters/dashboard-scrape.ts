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

export function createGitHubInvoiceAdapter(
  options: { driver?: ScrapeInvoiceDriver } = {},
): DashboardScrapeInvoiceAdapter {
  return new DashboardScrapeInvoiceAdapter({
    id: 'github',
    displayName: 'GitHub',
    loginUrl: 'https://github.com/settings/billing/summary',
    driver: options.driver,
  });
}

export function createOpenAIInvoiceAdapter(
  options: { driver?: ScrapeInvoiceDriver } = {},
): DashboardScrapeInvoiceAdapter {
  return new DashboardScrapeInvoiceAdapter({
    id: 'openai',
    displayName: 'OpenAI',
    loginUrl: 'https://platform.openai.com/account/billing',
    driver: options.driver,
  });
}

export function createAnthropicInvoiceAdapter(
  options: { driver?: ScrapeInvoiceDriver } = {},
): DashboardScrapeInvoiceAdapter {
  return new DashboardScrapeInvoiceAdapter({
    id: 'anthropic',
    displayName: 'Anthropic',
    loginUrl: 'https://console.anthropic.com/settings/billing',
    driver: options.driver,
  });
}

export function createAtlassianInvoiceAdapter(
  options: { driver?: ScrapeInvoiceDriver } = {},
): DashboardScrapeInvoiceAdapter {
  return new DashboardScrapeInvoiceAdapter({
    id: 'atlassian',
    displayName: 'Atlassian',
    loginUrl: 'https://my.atlassian.com/billing',
    driver: options.driver,
  });
}

export function createLinkedInInvoiceAdapter(
  options: { driver?: ScrapeInvoiceDriver } = {},
): DashboardScrapeInvoiceAdapter {
  return new DashboardScrapeInvoiceAdapter({
    id: 'linkedin',
    displayName: 'LinkedIn Campaign Manager',
    loginUrl: 'https://www.linkedin.com/campaignmanager/accounts',
    driver: options.driver,
  });
}

export function createPlaywrightScrapeDriver(
  plan: ScrapeInvoicePlan,
): ScrapeInvoiceDriver {
  return new PlaywrightScrapeInvoiceDriver(plan);
}
