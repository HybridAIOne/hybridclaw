import {
  createAwsInvoiceAdapter,
  createAzureInvoiceAdapter,
  createGcpInvoiceAdapter,
  createGoogleAdsInvoiceAdapter,
  type InvoiceApiClient,
} from './adapters/api-client.js';
import {
  createAnthropicInvoiceAdapter,
  createAtlassianInvoiceAdapter,
  createGitHubInvoiceAdapter,
  createLinkedInInvoiceAdapter,
  createOpenAIInvoiceAdapter,
  type ScrapeInvoiceDriver,
} from './adapters/dashboard-scrape.js';
import { StripeInvoiceAdapter } from './adapters/stripe.js';
import type { InvoiceAdapter, InvoiceProviderId } from './types.js';

type FetchLike = typeof fetch;

export type InvoiceProviderMode = 'api' | 'scrape';
export type InvoiceProviderStatus = 'available' | 'driver-required';

export interface InvoiceProviderDefinition {
  id: InvoiceProviderId;
  displayName: string;
  mode: InvoiceProviderMode;
  status: InvoiceProviderStatus;
  credentialKeys: string[];
}

export const INVOICE_PROVIDER_DEFINITIONS: InvoiceProviderDefinition[] = [
  {
    id: 'stripe',
    displayName: 'Stripe',
    mode: 'api',
    status: 'available',
    credentialKeys: ['apiKey'],
  },
  {
    id: 'github',
    displayName: 'GitHub',
    mode: 'scrape',
    status: 'driver-required',
    credentialKeys: ['username', 'password', 'totpSecret'],
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    mode: 'scrape',
    status: 'driver-required',
    credentialKeys: ['username', 'password', 'totpSecret'],
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    mode: 'scrape',
    status: 'driver-required',
    credentialKeys: ['username', 'password', 'totpSecret'],
  },
  {
    id: 'atlassian',
    displayName: 'Atlassian',
    mode: 'scrape',
    status: 'driver-required',
    credentialKeys: ['username', 'password', 'totpSecret'],
  },
  {
    id: 'linkedin',
    displayName: 'LinkedIn Campaign Manager',
    mode: 'scrape',
    status: 'driver-required',
    credentialKeys: ['username', 'password', 'totpSecret', 'adAccountId'],
  },
  {
    id: 'google-ads',
    displayName: 'Google Ads',
    mode: 'api',
    status: 'available',
    credentialKeys: ['accessToken', 'developerToken', 'customerId'],
  },
  {
    id: 'aws',
    displayName: 'AWS',
    mode: 'api',
    status: 'available',
    credentialKeys: ['accessKeyId', 'secretAccessKey', 'region'],
  },
  {
    id: 'gcp',
    displayName: 'GCP',
    mode: 'api',
    status: 'available',
    credentialKeys: ['accessToken', 'billingAccountId'],
  },
  {
    id: 'azure',
    displayName: 'Azure',
    mode: 'api',
    status: 'available',
    credentialKeys: ['accessToken', 'billingAccountId'],
  },
];

export function createReferenceInvoiceAdapters(
  options: {
    fetch?: FetchLike;
    scrapeDrivers?: Partial<Record<InvoiceProviderId, ScrapeInvoiceDriver>>;
    apiClients?: Partial<Record<InvoiceProviderId, InvoiceApiClient>>;
  } = {},
): InvoiceAdapter[] {
  const adapters: InvoiceAdapter[] = [
    new StripeInvoiceAdapter({ fetch: options.fetch }),
    createGitHubInvoiceAdapter({ driver: options.scrapeDrivers?.github }),
    createOpenAIInvoiceAdapter({ driver: options.scrapeDrivers?.openai }),
    createAnthropicInvoiceAdapter({
      driver: options.scrapeDrivers?.anthropic,
    }),
    createAtlassianInvoiceAdapter({
      driver: options.scrapeDrivers?.atlassian,
    }),
    createLinkedInInvoiceAdapter({ driver: options.scrapeDrivers?.linkedin }),
  ];

  if (options.apiClients?.['google-ads']) {
    adapters.push(
      createGoogleAdsInvoiceAdapter(options.apiClients['google-ads']),
    );
  }
  if (options.apiClients?.aws) {
    adapters.push(createAwsInvoiceAdapter(options.apiClients.aws));
  }
  if (options.apiClients?.gcp) {
    adapters.push(createGcpInvoiceAdapter(options.apiClients.gcp));
  }
  if (options.apiClients?.azure) {
    adapters.push(createAzureInvoiceAdapter(options.apiClients.azure));
  }

  return adapters;
}

export function createLaunchInvoiceAdapters(options: {
  fetch?: FetchLike;
  scrapeDrivers: Partial<Record<InvoiceProviderId, ScrapeInvoiceDriver>>;
  apiClients: Pick<
    Record<InvoiceProviderId, InvoiceApiClient>,
    'google-ads' | 'aws' | 'gcp' | 'azure'
  >;
}): InvoiceAdapter[] {
  return [
    new StripeInvoiceAdapter({ fetch: options.fetch }),
    createGitHubInvoiceAdapter({ driver: options.scrapeDrivers.github }),
    createOpenAIInvoiceAdapter({ driver: options.scrapeDrivers.openai }),
    createAnthropicInvoiceAdapter({ driver: options.scrapeDrivers.anthropic }),
    createAtlassianInvoiceAdapter({ driver: options.scrapeDrivers.atlassian }),
    createLinkedInInvoiceAdapter({ driver: options.scrapeDrivers.linkedin }),
    createGoogleAdsInvoiceAdapter(options.apiClients['google-ads']),
    createAwsInvoiceAdapter(options.apiClients.aws),
    createGcpInvoiceAdapter(options.apiClients.gcp),
    createAzureInvoiceAdapter(options.apiClients.azure),
  ];
}
