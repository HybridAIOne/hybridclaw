import { createHash, createHmac } from 'node:crypto';
import { sinceTimestamp } from '../date-utils.js';
import type {
  InvoiceAdapter,
  InvoiceAdapterContext,
  InvoiceCredentials,
  InvoiceListOptions,
  InvoiceMeta,
} from '../types.js';

type FetchLike = typeof fetch;

interface ApiInvoiceSession {
  credentials: InvoiceCredentials;
  context: InvoiceAdapterContext;
}

interface HttpInvoiceAdapterOptions {
  fetch?: FetchLike;
}

type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue };

function requireCredential(
  credentials: InvoiceCredentials,
  key: string,
  displayName: string,
): string {
  const value = credentials[key];
  if (!value) {
    throw new Error(
      `${displayName} invoice adapter requires credentials.${key}.`,
    );
  }
  return value;
}

function isoDate(
  value: string | number | undefined,
  fieldName: string,
): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime()))
      return parsed.toISOString().slice(0, 10);
  }
  if (typeof value === 'number') {
    const millis = value > 10_000_000_000 ? value : value * 1000;
    const parsed = new Date(millis);
    if (Number.isFinite(parsed.getTime()))
      return parsed.toISOString().slice(0, 10);
  }
  throw new Error(`Invoice payload is missing valid ${fieldName}.`);
}

function periodFromDate(value: string): string {
  return isoDate(value, 'period date').slice(0, 7);
}

function invoiceIssuePeriod(options: InvoiceListOptions): {
  year: number;
  month: number;
  googleAdsMonth: string;
  startDate: string;
  endDate: string;
} {
  const timestamp = sinceTimestamp(options, 'invoice since date') ?? Date.now();
  const start = new Date(timestamp);
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth() + 1;
  const end = new Date(Date.UTC(year, month, 0));
  const googleAdsMonths = [
    'JANUARY',
    'FEBRUARY',
    'MARCH',
    'APRIL',
    'MAY',
    'JUNE',
    'JULY',
    'AUGUST',
    'SEPTEMBER',
    'OCTOBER',
    'NOVEMBER',
    'DECEMBER',
  ];
  return {
    year,
    month,
    googleAdsMonth: googleAdsMonths[month - 1] as string,
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

function moneyFromMicros(value: string | number | undefined): number {
  const numeric =
    typeof value === 'string' ? Number.parseFloat(value) : Number(value || 0);
  return Number((numeric / 1_000_000).toFixed(2));
}

function moneyFromDecimal(value: string | number | undefined): number {
  const numeric =
    typeof value === 'string' ? Number.parseFloat(value) : Number(value || 0);
  return Number(numeric.toFixed(2));
}

function vatRate(net: number, vat: number): number {
  return net > 0 ? Number((vat / net).toFixed(4)) : 0;
}

async function readJson(response: Response, label: string): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`${label} failed with HTTP ${response.status}.`);
  }
  return response.json() as Promise<unknown>;
}

async function readPdf(response: Response, label: string): Promise<Uint8Array> {
  if (!response.ok) {
    throw new Error(`${label} failed with HTTP ${response.status}.`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export class GoogleAdsInvoiceAdapter
  implements InvoiceAdapter<ApiInvoiceSession>
{
  readonly id = 'google-ads' as const;
  readonly displayName = 'Google Ads';
  readonly #fetch: FetchLike;
  readonly #apiVersion: string;

  constructor(
    options: HttpInvoiceAdapterOptions & { apiVersion?: string } = {},
  ) {
    this.#fetch = options.fetch || fetch;
    this.#apiVersion = options.apiVersion || 'v20';
  }

  async login(
    credentials: InvoiceCredentials,
    context: InvoiceAdapterContext,
  ): Promise<ApiInvoiceSession> {
    requireCredential(credentials, 'accessToken', this.displayName);
    requireCredential(credentials, 'developerToken', this.displayName);
    requireCredential(credentials, 'customerId', this.displayName);
    requireCredential(credentials, 'billingSetup', this.displayName);
    return { credentials, context };
  }

  async listInvoices(
    session: ApiInvoiceSession,
    options: InvoiceListOptions,
  ): Promise<InvoiceMeta[]> {
    const { credentials } = session;
    const period = invoiceIssuePeriod(options);
    const customerId = credentials.customerId.replace(/-/g, '');
    const url = new URL(
      `https://googleads.googleapis.com/${this.#apiVersion}/customers/${customerId}/invoices`,
    );
    url.searchParams.set('billingSetup', credentials.billingSetup);
    url.searchParams.set('issueYear', String(period.year));
    url.searchParams.set('issueMonth', period.googleAdsMonth);

    const response = await this.#fetch(url, {
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        'developer-token': credentials.developerToken,
        ...(credentials.loginCustomerId
          ? { 'login-customer-id': credentials.loginCustomerId }
          : {}),
      },
    });
    const payload = (await readJson(response, 'Google Ads invoice list')) as {
      invoices?: Array<Record<string, unknown>>;
    };

    return (payload.invoices || []).map((invoice) => {
      const invoiceNo = String(invoice.id || invoice.resourceName || '');
      if (!invoiceNo) throw new Error('Google Ads invoice is missing id.');
      const issueDate = formatGoogleAdsDate(invoice.issueDate, 'issue_date');
      const dueDate = formatGoogleAdsDate(invoice.dueDate, 'due_date');
      const serviceDateRange = invoice.serviceDateRange as
        | { startDate?: unknown }
        | undefined;
      const net = moneyFromMicros(
        invoice.subtotalAmountMicros as string | number | undefined,
      );
      const vat = moneyFromMicros(
        invoice.taxAmountMicros as string | number | undefined,
      );
      const gross = moneyFromMicros(
        invoice.totalAmountMicros as string | number | undefined,
      );
      const sourceUrl = String(invoice.pdfUrl || '');
      if (!sourceUrl) {
        throw new Error(`Google Ads invoice ${invoiceNo} is missing pdfUrl.`);
      }
      const currency = String(
        invoice.currencyCode || credentials.currency || '',
      );
      if (!/^[A-Z]{3}$/u.test(currency)) {
        throw new Error(
          `Google Ads invoice ${invoiceNo} is missing currencyCode.`,
        );
      }
      return {
        vendor: 'google-ads',
        invoice_no: invoiceNo,
        period: serviceDateRange?.startDate
          ? formatGoogleAdsDate(
              serviceDateRange.startDate,
              'service start',
            ).slice(0, 7)
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

  async download(
    session: ApiInvoiceSession,
    invoice: InvoiceMeta,
  ): Promise<Uint8Array> {
    return readPdf(
      await this.#fetch(invoice.source_url, {
        headers: {
          Authorization: `Bearer ${session.credentials.accessToken}`,
          'developer-token': session.credentials.developerToken,
        },
      }),
      `Google Ads invoice ${invoice.invoice_no} PDF download`,
    );
  }
}

function formatGoogleAdsDate(value: unknown, fieldName: string): string {
  if (typeof value === 'string') return isoDate(value, fieldName);
  if (value && typeof value === 'object') {
    const date = value as { year?: unknown; month?: unknown; day?: unknown };
    const year = Number(date.year);
    const month = Number(date.month);
    const day = Number(date.day);
    if (year && month && day) {
      return `${year.toString().padStart(4, '0')}-${month
        .toString()
        .padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
    }
  }
  throw new Error(`Google Ads invoice is missing ${fieldName}.`);
}

export class AwsInvoiceAdapter implements InvoiceAdapter<ApiInvoiceSession> {
  readonly id = 'aws' as const;
  readonly displayName = 'AWS';
  readonly #fetch: FetchLike;

  constructor(options: HttpInvoiceAdapterOptions = {}) {
    this.#fetch = options.fetch || fetch;
  }

  async login(
    credentials: InvoiceCredentials,
    context: InvoiceAdapterContext,
  ): Promise<ApiInvoiceSession> {
    requireCredential(credentials, 'accessKeyId', this.displayName);
    requireCredential(credentials, 'secretAccessKey', this.displayName);
    requireCredential(credentials, 'accountId', this.displayName);
    return { credentials, context };
  }

  async listInvoices(
    session: ApiInvoiceSession,
    options: InvoiceListOptions,
  ): Promise<InvoiceMeta[]> {
    const period = invoiceIssuePeriod(options);
    const payload = await this.#awsJson(
      session.credentials,
      'ListInvoiceSummaries',
      {
        Selector: {
          ResourceType: 'ACCOUNT_ID',
          Value: session.credentials.accountId,
        },
        Filter: {
          BillingPeriod: {
            Month: period.month,
            Year: period.year,
          },
        },
        MaxResults: 100,
      },
    );
    const summaries = (
      payload as { InvoiceSummaries?: Array<Record<string, unknown>> }
    ).InvoiceSummaries;
    return (summaries || []).map((summary) => {
      const invoiceNo = String(summary.InvoiceId || '');
      if (!invoiceNo)
        throw new Error('AWS invoice summary is missing InvoiceId.');
      const billingPeriod = summary.BillingPeriod as
        | { Month?: unknown; Year?: unknown }
        | undefined;
      const amount = summary.PaymentCurrencyAmount as
        | {
            CurrencyCode?: unknown;
            TotalAmountBeforeTax?: unknown;
            TotalAmount?: unknown;
            AmountBreakdown?: {
              Taxes?: { TotalAmount?: unknown };
            };
          }
        | undefined;
      const net = moneyFromDecimal(amount?.TotalAmountBeforeTax as string);
      const gross = moneyFromDecimal(amount?.TotalAmount as string);
      const vat = moneyFromDecimal(
        amount?.AmountBreakdown?.Taxes?.TotalAmount as string,
      );
      const currency = String(amount?.CurrencyCode || '');
      if (!/^[A-Z]{3}$/u.test(currency)) {
        throw new Error(`AWS invoice ${invoiceNo} is missing CurrencyCode.`);
      }
      return {
        vendor: 'aws',
        invoice_no: invoiceNo,
        period:
          billingPeriod?.Year && billingPeriod.Month
            ? `${String(billingPeriod.Year).padStart(4, '0')}-${String(
                billingPeriod.Month,
              ).padStart(2, '0')}`
            : periodFromDate(
                isoDate(summary.IssuedDate as number, 'IssuedDate'),
              ),
        issue_date: isoDate(summary.IssuedDate as number, 'IssuedDate'),
        due_date: isoDate(summary.DueDate as number, 'DueDate'),
        net,
        vat_rate: vatRate(net, vat),
        vat,
        gross,
        currency,
        source_url: `aws-invoicing://${invoiceNo}`,
      };
    });
  }

  async download(
    session: ApiInvoiceSession,
    invoice: InvoiceMeta,
  ): Promise<Uint8Array> {
    const payload = await this.#awsJson(session.credentials, 'GetInvoicePDF', {
      InvoiceId: invoice.invoice_no,
    });
    const documentUrl = String(
      (payload as { InvoicePDF?: { DocumentUrl?: unknown } }).InvoicePDF
        ?.DocumentUrl || '',
    );
    if (!documentUrl) {
      throw new Error(
        `AWS invoice ${invoice.invoice_no} PDF response is missing DocumentUrl.`,
      );
    }
    return readPdf(
      await this.#fetch(documentUrl),
      `AWS invoice ${invoice.invoice_no} PDF download`,
    );
  }

  async #awsJson(
    credentials: InvoiceCredentials,
    action: string,
    payload: Record<string, JsonValue>,
  ): Promise<unknown> {
    const region = credentials.region || 'us-east-1';
    const endpoint = new URL(
      credentials.endpointUrl || `https://invoicing.${region}.amazonaws.com`,
    );
    const body = JSON.stringify(payload);
    const headers = signAwsJsonRequest({
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
      region,
      service: 'invoicing',
      host: endpoint.host,
      target: `${credentials.targetPrefix || 'AWSInvoicingService'}.${action}`,
      body,
      now: new Date(),
    });
    return readJson(
      await this.#fetch(endpoint, {
        method: 'POST',
        headers,
        body,
      }),
      `AWS ${action}`,
    );
  }
}

function signAwsJsonRequest(input: {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  service: string;
  host: string;
  target: string;
  body: string;
  now: Date;
}): Record<string, string> {
  const amzDate = input.now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = createHash('sha256').update(input.body).digest('hex');
  const baseHeaders: Record<string, string> = {
    'content-type': 'application/x-amz-json-1.1',
    host: input.host,
    'x-amz-date': amzDate,
    'x-amz-target': input.target,
  };
  if (input.sessionToken) {
    baseHeaders['x-amz-security-token'] = input.sessionToken;
  }
  const signedHeaders = Object.keys(baseHeaders).sort().join(';');
  const canonicalHeaders = Object.keys(baseHeaders)
    .sort()
    .map((key) => `${key}:${baseHeaders[key]}\n`)
    .join('');
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const credentialScope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const signingKey = hmac(
    hmac(
      hmac(hmac(`AWS4${input.secretAccessKey}`, dateStamp), input.region),
      input.service,
    ),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey)
    .update(stringToSign)
    .digest('hex');
  return {
    ...baseHeaders,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

export class AzureInvoiceAdapter implements InvoiceAdapter<ApiInvoiceSession> {
  readonly id = 'azure' as const;
  readonly displayName = 'Azure';
  readonly #fetch: FetchLike;
  readonly #apiVersion: string;

  constructor(
    options: HttpInvoiceAdapterOptions & { apiVersion?: string } = {},
  ) {
    this.#fetch = options.fetch || fetch;
    this.#apiVersion = options.apiVersion || '2024-04-01';
  }

  async login(
    credentials: InvoiceCredentials,
    context: InvoiceAdapterContext,
  ): Promise<ApiInvoiceSession> {
    requireCredential(credentials, 'accessToken', this.displayName);
    requireCredential(credentials, 'billingAccountId', this.displayName);
    return { credentials, context };
  }

  async listInvoices(
    session: ApiInvoiceSession,
    options: InvoiceListOptions,
  ): Promise<InvoiceMeta[]> {
    const period = invoiceIssuePeriod(options);
    const url = new URL(
      `https://management.azure.com/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(
        session.credentials.billingAccountId,
      )}/invoices`,
    );
    url.searchParams.set('api-version', this.#apiVersion);
    url.searchParams.set('periodStartDate', period.startDate);
    url.searchParams.set('periodEndDate', period.endDate);
    const payload = (await readJson(
      await this.#fetch(url, {
        headers: {
          Authorization: `Bearer ${session.credentials.accessToken}`,
        },
      }),
      'Azure invoice list',
    )) as { value?: Array<Record<string, unknown>> };

    return (payload.value || []).map((invoice) => {
      const props = (invoice.properties || invoice) as Record<string, unknown>;
      const invoiceNo = String(
        invoice.name || props.invoiceName || props.id || '',
      );
      if (!invoiceNo) throw new Error('Azure invoice payload is missing name.');
      const net = moneyFromDecimal(
        unwrapAzureAmount(props.subTotal || props.subtotal || props.amountDue),
      );
      const vat = moneyFromDecimal(
        unwrapAzureAmount(props.taxAmount || props.totalTax),
      );
      const gross = moneyFromDecimal(
        unwrapAzureAmount(props.totalAmount || props.amountDue),
      );
      const currency = String(
        props.currency ||
          props.currencyCode ||
          session.credentials.currency ||
          '',
      );
      if (!/^[A-Z]{3}$/u.test(currency)) {
        throw new Error(`Azure invoice ${invoiceNo} is missing currency.`);
      }
      return {
        vendor: 'azure',
        invoice_no: invoiceNo,
        period: periodFromDate(
          isoDate(
            (props.billingPeriodStartDate || props.invoiceDate) as string,
            'billingPeriodStartDate',
          ),
        ),
        issue_date: isoDate(props.invoiceDate as string, 'invoiceDate'),
        due_date: isoDate(
          (props.dueDate || props.invoiceDate) as string,
          'dueDate',
        ),
        net,
        vat_rate: vatRate(net, vat),
        vat,
        gross,
        currency,
        source_url: azureDownloadUrl(
          session.credentials.billingAccountId,
          invoiceNo,
          this.#apiVersion,
        ),
      };
    });
  }

  async download(
    session: ApiInvoiceSession,
    invoice: InvoiceMeta,
  ): Promise<Uint8Array> {
    const response = await this.#fetch(invoice.source_url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.credentials.accessToken}`,
      },
    });
    const payload = (await readJson(
      response,
      `Azure invoice ${invoice.invoice_no} download URL`,
    )) as Record<string, unknown>;
    const downloadUrl = String(
      payload.url ||
        payload.downloadUrl ||
        (payload.properties as { downloadUrl?: unknown } | undefined)
          ?.downloadUrl ||
        '',
    );
    if (!downloadUrl) {
      throw new Error(
        `Azure invoice ${invoice.invoice_no} response is missing downloadUrl.`,
      );
    }
    return readPdf(
      await this.#fetch(downloadUrl),
      `Azure invoice ${invoice.invoice_no} PDF download`,
    );
  }
}

function unwrapAzureAmount(value: unknown): string | number | undefined {
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const amount = value as { value?: unknown; amount?: unknown };
    if (typeof amount.value === 'string' || typeof amount.value === 'number') {
      return amount.value;
    }
    if (
      typeof amount.amount === 'string' ||
      typeof amount.amount === 'number'
    ) {
      return amount.amount;
    }
  }
  return undefined;
}

function azureDownloadUrl(
  billingAccountId: string,
  invoiceName: string,
  apiVersion: string,
): string {
  const url = new URL(
    `https://management.azure.com/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(
      billingAccountId,
    )}/invoices/${encodeURIComponent(invoiceName)}/download`,
  );
  url.searchParams.set('api-version', apiVersion);
  return url.href;
}

export function createGoogleAdsInvoiceAdapter(
  options: HttpInvoiceAdapterOptions & { apiVersion?: string } = {},
): GoogleAdsInvoiceAdapter {
  return new GoogleAdsInvoiceAdapter(options);
}

export function createAwsInvoiceAdapter(
  options: HttpInvoiceAdapterOptions = {},
): AwsInvoiceAdapter {
  return new AwsInvoiceAdapter(options);
}

export function createAzureInvoiceAdapter(
  options: HttpInvoiceAdapterOptions & { apiVersion?: string } = {},
): AzureInvoiceAdapter {
  return new AzureInvoiceAdapter(options);
}
