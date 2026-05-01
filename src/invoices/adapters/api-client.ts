import type {
  InvoiceAdapter,
  InvoiceAdapterContext,
  InvoiceCredentials,
  InvoiceListOptions,
  InvoiceMeta,
  InvoiceProviderId,
} from '../types.js';

export interface InvoiceApiClient {
  login?(
    credentials: InvoiceCredentials,
    context: InvoiceAdapterContext,
  ): Promise<unknown>;
  listInvoices(params: {
    credentials: InvoiceCredentials;
    context: InvoiceAdapterContext;
    session: unknown;
    options: InvoiceListOptions;
  }): Promise<InvoiceMeta[]>;
  downloadInvoice(params: {
    credentials: InvoiceCredentials;
    context: InvoiceAdapterContext;
    session: unknown;
    invoice: InvoiceMeta;
  }): Promise<Uint8Array>;
}

interface ApiInvoiceSession {
  credentials: InvoiceCredentials;
  context: InvoiceAdapterContext;
  session: unknown;
}

export class ApiClientInvoiceAdapter
  implements InvoiceAdapter<ApiInvoiceSession>
{
  readonly id: InvoiceProviderId;
  readonly displayName: string;
  readonly #requiredCredentialKeys: string[];
  readonly #client: InvoiceApiClient;

  constructor(options: {
    id: InvoiceProviderId;
    displayName: string;
    requiredCredentialKeys: string[];
    client: InvoiceApiClient;
  }) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.#requiredCredentialKeys = options.requiredCredentialKeys;
    this.#client = options.client;
  }

  async login(
    credentials: InvoiceCredentials,
    context: InvoiceAdapterContext,
  ): Promise<ApiInvoiceSession> {
    for (const key of this.#requiredCredentialKeys) {
      if (!credentials[key]) {
        throw new Error(
          `${this.displayName} invoice adapter requires credentials.${key}.`,
        );
      }
    }

    return {
      credentials,
      context,
      session: this.#client.login
        ? await this.#client.login(credentials, context)
        : null,
    };
  }

  async listInvoices(
    session: ApiInvoiceSession,
    options: InvoiceListOptions,
  ): Promise<InvoiceMeta[]> {
    return this.#client.listInvoices({
      credentials: session.credentials,
      context: session.context,
      session: session.session,
      options,
    });
  }

  async download(
    session: ApiInvoiceSession,
    invoice: InvoiceMeta,
  ): Promise<Uint8Array> {
    return this.#client.downloadInvoice({
      credentials: session.credentials,
      context: session.context,
      session: session.session,
      invoice,
    });
  }
}

export function createGoogleAdsInvoiceAdapter(
  client: InvoiceApiClient,
): ApiClientInvoiceAdapter {
  return new ApiClientInvoiceAdapter({
    id: 'google-ads',
    displayName: 'Google Ads',
    requiredCredentialKeys: ['accessToken', 'developerToken', 'customerId'],
    client,
  });
}

export function createAwsInvoiceAdapter(
  client: InvoiceApiClient,
): ApiClientInvoiceAdapter {
  return new ApiClientInvoiceAdapter({
    id: 'aws',
    displayName: 'AWS',
    requiredCredentialKeys: ['accessKeyId', 'secretAccessKey', 'region'],
    client,
  });
}

export function createGcpInvoiceAdapter(
  client: InvoiceApiClient,
): ApiClientInvoiceAdapter {
  return new ApiClientInvoiceAdapter({
    id: 'gcp',
    displayName: 'GCP',
    requiredCredentialKeys: ['accessToken', 'billingAccountId'],
    client,
  });
}

export function createAzureInvoiceAdapter(
  client: InvoiceApiClient,
): ApiClientInvoiceAdapter {
  return new ApiClientInvoiceAdapter({
    id: 'azure',
    displayName: 'Azure',
    requiredCredentialKeys: ['accessToken', 'billingAccountId'],
    client,
  });
}
