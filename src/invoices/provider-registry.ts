import {
  createAwsInvoiceAdapter,
  createAzureInvoiceAdapter,
  createGoogleAdsInvoiceAdapter,
} from './adapters/api-client.js';
import {
  createAnthropicInvoiceAdapter,
  createAtlassianInvoiceAdapter,
  createGcpInvoiceAdapter,
  createGitHubInvoiceAdapter,
  createLinkedInInvoiceAdapter,
  createOpenAIInvoiceAdapter,
  type ScrapeInvoiceDriver,
} from './adapters/dashboard-scrape.js';
import { StripeInvoiceAdapter } from './adapters/stripe.js';
import type { InvoiceAdapter, InvoiceProviderId } from './types.js';

type FetchLike = typeof fetch;

export interface InvoiceProviderDefinition {
  id: InvoiceProviderId;
  displayName: string;
}

export const INVOICE_PROVIDER_DEFINITIONS: InvoiceProviderDefinition[] = [
  { id: 'stripe', displayName: 'Stripe' },
  { id: 'github', displayName: 'GitHub' },
  { id: 'openai', displayName: 'OpenAI' },
  { id: 'anthropic', displayName: 'Anthropic' },
  { id: 'atlassian', displayName: 'Atlassian' },
  { id: 'linkedin', displayName: 'LinkedIn Campaign Manager' },
  { id: 'google-ads', displayName: 'Google Ads' },
  { id: 'aws', displayName: 'AWS' },
  { id: 'gcp', displayName: 'GCP' },
  { id: 'azure', displayName: 'Azure' },
];

function createScrapeAdapters(
  drivers: Partial<Record<InvoiceProviderId, ScrapeInvoiceDriver>> = {},
): InvoiceAdapter[] {
  return [
    createGitHubInvoiceAdapter({ driver: drivers.github }),
    createOpenAIInvoiceAdapter({ driver: drivers.openai }),
    createAnthropicInvoiceAdapter({ driver: drivers.anthropic }),
    createAtlassianInvoiceAdapter({ driver: drivers.atlassian }),
    createLinkedInInvoiceAdapter({ driver: drivers.linkedin }),
    createGcpInvoiceAdapter({ driver: drivers.gcp }),
  ];
}

export function createReferenceInvoiceAdapters(
  options: {
    fetch?: FetchLike;
    scrapeDrivers?: Partial<Record<InvoiceProviderId, ScrapeInvoiceDriver>>;
  } = {},
): InvoiceAdapter[] {
  return [
    new StripeInvoiceAdapter({ fetch: options.fetch }),
    ...createScrapeAdapters(options.scrapeDrivers),
    createGoogleAdsInvoiceAdapter({ fetch: options.fetch }),
    createAwsInvoiceAdapter({ fetch: options.fetch }),
    createAzureInvoiceAdapter({ fetch: options.fetch }),
  ];
}

export function createLaunchInvoiceAdapters(options: {
  fetch?: FetchLike;
  scrapeDrivers: Partial<Record<InvoiceProviderId, ScrapeInvoiceDriver>>;
}): InvoiceAdapter[] {
  return [
    new StripeInvoiceAdapter({ fetch: options.fetch }),
    ...createScrapeAdapters(options.scrapeDrivers),
    createGoogleAdsInvoiceAdapter({ fetch: options.fetch }),
    createAwsInvoiceAdapter({ fetch: options.fetch }),
    createAzureInvoiceAdapter({ fetch: options.fetch }),
  ];
}
