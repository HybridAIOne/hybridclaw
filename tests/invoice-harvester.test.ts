import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  createAwsInvoiceAdapter,
  createAzureInvoiceAdapter,
  createGcpInvoiceAdapter,
  createGitHubInvoiceAdapter,
  createGoogleAdsInvoiceAdapter,
  DatevUnternehmenOnlineUploadAdapter,
  generateTotp,
  harvestProviderInvoices,
  INVOICE_PROVIDER_DEFINITIONS,
  INVOICE_SCRAPE_PLANS,
  type InvoiceAdapter,
  type InvoiceMeta,
  type InvoiceProviderId,
  loadInvoiceManifest,
  parseInvoiceMoneyText,
  RecordedFixtureInvoiceAdapter,
  resolveInvoiceCredentials,
  runMonthlyInvoiceRun,
  type ScrapeInvoiceDriver,
  StripeInvoiceAdapter,
  saveInvoiceManifest,
  validateInvoiceHarvesterConfig,
  validateInvoiceRecord,
} from '../src/invoices/index.js';

const invoiceMeta: InvoiceMeta = {
  vendor: 'openai',
  invoice_no: 'OA-2026-03-001',
  period: '2026-03',
  issue_date: '2026-04-01',
  due_date: '2026-04-15',
  net: 100,
  vat_rate: 0.19,
  vat: 19,
  gross: 119,
  currency: 'EUR',
  source_url: 'https://platform.openai.com/account/billing',
};

afterEach(() => {
  delete process.env.HYBRIDCLAW_INVOICE_TEST_SECRET;
  vi.restoreAllMocks();
});

describe('invoice schema', () => {
  test('validates the normalized invoice record contract', () => {
    const normalized = { ...invoiceMeta };
    const record = validateInvoiceRecord({
      ...normalized,
      pdf_path: 'runs/2026-03/openai/OA-2026-03-001.pdf',
      checksum_sha256:
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    });

    expect(record.vendor).toBe('openai');
    expect(() => validateInvoiceRecord({ ...record, vat_rate: 1.5 })).toThrow(
      /vat_rate/u,
    );
  });
});

describe('invoice credentials', () => {
  test('resolves vault-compatible secret refs without stringifying handles', () => {
    process.env.HYBRIDCLAW_INVOICE_TEST_SECRET = 'stripe-test-key';
    const audit = vi.fn();

    const credentials = resolveInvoiceCredentials(
      'stripe',
      {
        apiKey: {
          source: 'env',
          id: 'HYBRIDCLAW_INVOICE_TEST_SECRET',
        },
      },
      { required: ['apiKey'], audit },
    );

    expect(credentials).toEqual({ apiKey: 'stripe-test-key' });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'HYBRIDCLAW_INVOICE_TEST_SECRET' }),
      'resolve stripe invoice credential apiKey',
    );
  });
});

describe('invoice harvester', () => {
  test('writes PDFs, manifests records, dedupes reruns, and audits fetched invoices', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-invoices-'));
    const adapter: InvoiceAdapter<undefined> = {
      id: 'openai',
      displayName: 'OpenAI',
      async login() {
        return undefined;
      },
      async listInvoices() {
        return [invoiceMeta];
      },
      async download() {
        return new TextEncoder().encode('%PDF-1.7 invoice');
      },
    };
    const recordAudit = vi.fn();

    const first = await harvestProviderInvoices({
      adapter,
      credentials: {},
      outputDir,
      sessionId: 'session-invoice-test',
      runId: 'invoice-run',
      recordAudit,
    });
    const second = await harvestProviderInvoices({
      adapter,
      credentials: {},
      outputDir,
      sessionId: 'session-invoice-test',
      runId: 'invoice-run',
      recordAudit,
    });

    expect(first.fetched).toHaveLength(1);
    expect(second.fetched).toHaveLength(0);
    expect(second.duplicates).toEqual([
      expect.objectContaining({ reason: 'identity' }),
    ]);
    expect(
      fs.existsSync(path.join(outputDir, first.fetched[0]?.pdf_path || '')),
    ).toBe(true);
    expect(loadInvoiceManifest(first.manifestPath).records).toHaveLength(1);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-invoice-test',
        runId: 'invoice-run',
        event: expect.objectContaining({
          type: 'invoice.fetched',
          vendor: 'openai',
          invoice_no: 'OA-2026-03-001',
        }),
      }),
    );
  });

  test('closes invoice sessions after harvest runs', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-invoices-'));
    const close = vi.fn(async () => undefined);
    const adapter: InvoiceAdapter<{ close: () => Promise<void> }> = {
      id: 'openai',
      displayName: 'OpenAI',
      async login() {
        return { close };
      },
      async listInvoices() {
        return [invoiceMeta];
      },
      async download() {
        return new TextEncoder().encode('%PDF-1.7 invoice');
      },
    };

    await harvestProviderInvoices({
      adapter,
      credentials: {},
      outputDir,
    });

    expect(close).toHaveBeenCalledOnce();
  });

  test('cleans up temporary manifest writes after atomic write failures', () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-invoices-'));
    const manifestPath = path.join(outputDir, 'manifest.json');
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('rename failed');
    });

    expect(() =>
      saveInvoiceManifest(manifestPath, {
        schema: 'hybridclaw.invoice-manifest.v1',
        records: [],
      }),
    ).toThrow(/rename failed/u);
    expect(
      fs.readdirSync(outputDir).filter((entry) => entry.endsWith('.tmp')),
    ).toEqual([]);

    rename.mockRestore();
  });

  test('reports malformed manifests with the file path', () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-invoices-'));
    const manifestPath = path.join(outputDir, 'manifest.json');
    fs.writeFileSync(manifestPath, '{not-json', 'utf-8');

    expect(() => loadInvoiceManifest(manifestPath)).toThrow(
      new RegExp(`Invalid invoice manifest at ${manifestPath}`),
    );
  });
});

describe('reference invoice adapters', () => {
  test('declares the launch provider set', () => {
    expect(INVOICE_PROVIDER_DEFINITIONS.map((provider) => provider.id)).toEqual(
      [
        'stripe',
        'github',
        'openai',
        'anthropic',
        'atlassian',
        'linkedin',
        'google-ads',
        'aws',
        'gcp',
        'azure',
      ],
    );
    expect(
      INVOICE_PROVIDER_DEFINITIONS.find((provider) => provider.id === 'stripe'),
    ).toMatchObject({
      displayName: 'Stripe',
    });
  });

  test('declares provider-specific scrape plans for dashboard adapters', () => {
    expect(Object.keys(INVOICE_SCRAPE_PLANS).sort()).toEqual([
      'anthropic',
      'atlassian',
      'gcp',
      'github',
      'linkedin',
      'openai',
    ]);
    expect(INVOICE_SCRAPE_PLANS.openai?.captchaSelector).toContain('captcha');
  });

  test('maps Stripe API invoices and downloads the official PDF', async () => {
    const fixture = fs.readFileSync(
      new URL('./fixtures/invoices/stripe-invoices.json', import.meta.url),
      'utf-8',
    );
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/v1/invoices')) {
        return new Response(fixture, { status: 200 });
      }
      return new Response('%PDF stripe', { status: 200 });
    });
    const adapter = new StripeInvoiceAdapter({
      fetch: fetchMock as typeof fetch,
    });
    const session = await adapter.login(
      { apiKey: 'sk_test' },
      { providerId: 'stripe' },
    );

    const invoices = await adapter.listInvoices(session, {
      since: '2026-03-01',
    });
    const pdf = await adapter.download(session, invoices[0] as InvoiceMeta);

    expect(invoices[0]).toMatchObject({
      vendor: 'stripe',
      invoice_no: 'ST-2026-03-001',
      period: '2026-03',
      issue_date: '2026-03-04',
      net: 100,
      vat: 19,
      gross: 119,
      currency: 'EUR',
    });
    expect(new TextDecoder().decode(pdf)).toBe('%PDF stripe');
  });

  test('rejects Stripe invoices missing required timestamps', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/v1/invoices')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'in_missing_created',
                number: 'ST-MISSING-CREATED',
                amount_subtotal: 10000,
                amount_paid: 11900,
                currency: 'eur',
                invoice_pdf: 'https://pay.stripe.com/invoice/missing/pdf',
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response('%PDF stripe', { status: 200 });
    });
    const adapter = new StripeInvoiceAdapter({
      fetch: fetchMock as typeof fetch,
    });
    const session = await adapter.login(
      { apiKey: 'sk_test' },
      { providerId: 'stripe' },
    );

    await expect(adapter.listInvoices(session, {})).rejects.toThrow(
      /missing period_start or created/u,
    );
  });

  test('normalizes common invoice money formats', () => {
    expect(parseInvoiceMoneyText('EUR 1,234.56')).toBe(1234.56);
    expect(parseInvoiceMoneyText('1.234,56 EUR')).toBe(1234.56);
    expect(parseInvoiceMoneyText('1,234')).toBe(1234);
    expect(parseInvoiceMoneyText('123,45')).toBe(123.45);
    expect(() => parseInvoiceMoneyText('not available')).toThrow(
      /Unable to parse/u,
    );
  });

  test('generates RFC 6238-compatible TOTP codes for scrape MFA', () => {
    expect(generateTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000)).toBe(
      '287082',
    );
  });

  test('scrape adapters use injected browser drivers for offline fixtures', async () => {
    const driver: ScrapeInvoiceDriver = {
      login: vi.fn(async () => undefined),
      listInvoices: vi.fn(async () => [invoiceMeta]),
      downloadInvoice: vi.fn(async () =>
        new TextEncoder().encode('%PDF openai'),
      ),
    };
    const adapter = createGitHubInvoiceAdapter({ driver });
    const session = await adapter.login(
      { username: 'user_a' },
      { providerId: 'github', profileDir: '/tmp/github-profile' },
    );

    await expect(adapter.listInvoices(session, {})).resolves.toEqual([
      invoiceMeta,
    ]);
    await expect(
      adapter.download(session, invoiceMeta),
    ).resolves.toBeInstanceOf(Uint8Array);
    expect(driver.login).toHaveBeenCalledWith(
      { username: 'user_a' },
      { providerId: 'github', profileDir: '/tmp/github-profile' },
    );
  });

  test('scrape adapters fail loudly when no browser driver is configured', async () => {
    const adapter = createGitHubInvoiceAdapter();

    await expect(adapter.login({}, { providerId: 'github' })).rejects.toThrow(
      /requires a Playwright driver/u,
    );
  });

  test('Google Ads adapter calls InvoiceService and downloads invoice PDFs', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/customers/1234567890/invoices')) {
        expect(url).toContain('issueYear=2026');
        expect(url).toContain('issueMonth=MARCH');
        return new Response(
          JSON.stringify({
            invoices: [
              {
                id: 'GA-2026-03-001',
                issueDate: { year: 2026, month: 4, day: 1 },
                dueDate: { year: 2026, month: 4, day: 15 },
                serviceDateRange: {
                  startDate: { year: 2026, month: 3, day: 1 },
                },
                subtotalAmountMicros: '100000000',
                taxAmountMicros: '19000000',
                totalAmountMicros: '119000000',
                currencyCode: 'EUR',
                pdfUrl: 'https://googleads.googleapis.com/invoices/pdf-1',
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response('%PDF google ads', { status: 200 });
    });
    const adapter = createGoogleAdsInvoiceAdapter({
      fetch: fetchMock as typeof fetch,
    });
    const session = await adapter.login(
      {
        accessToken: 'token',
        developerToken: 'developer',
        customerId: '123-456-7890',
        billingSetup: 'customers/1234567890/billingSetups/111',
      },
      { providerId: 'google-ads' },
    );

    const invoices = await adapter.listInvoices(session, {
      since: '2026-03-01',
    });
    const pdf = await adapter.download(session, invoices[0] as InvoiceMeta);

    expect(invoices[0]).toMatchObject({
      vendor: 'google-ads',
      invoice_no: 'GA-2026-03-001',
      period: '2026-03',
      net: 100,
      vat: 19,
      gross: 119,
    });
    expect(new TextDecoder().decode(pdf)).toBe('%PDF google ads');
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://googleads.googleapis.com/invoices/pdf-1',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer token',
          'developer-token': 'developer',
        }),
      }),
    );
  });

  test('AWS adapter signs Invoicing API requests and downloads invoice PDFs', async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('invoicing.us-east-1.amazonaws.com')) {
        expect(init?.headers).toEqual(
          expect.objectContaining({
            authorization: expect.stringContaining('AWS4-HMAC-SHA256'),
            'x-amz-target': expect.stringContaining('AWSInvoicingService.'),
          }),
        );
        const body = JSON.parse(String(init?.body || '{}')) as {
          InvoiceId?: string;
        };
        if (body.InvoiceId) {
          return new Response(
            JSON.stringify({
              InvoicePDF: {
                DocumentUrl: 'https://aws.example/invoices/pdf-1',
              },
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            InvoiceSummaries: [
              {
                InvoiceId: 'AWS-2026-03-001',
                BillingPeriod: { Month: 3, Year: 2026 },
                IssuedDate: '2026-04-01',
                DueDate: '2026-04-15',
                PaymentCurrencyAmount: {
                  CurrencyCode: 'EUR',
                  TotalAmountBeforeTax: '100',
                  AmountBreakdown: { Taxes: { TotalAmount: '19' } },
                  TotalAmount: '119',
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response('%PDF aws', { status: 200 });
    });
    const adapter = createAwsInvoiceAdapter({
      fetch: fetchMock as typeof fetch,
    });
    const session = await adapter.login(
      {
        accessKeyId: 'AKIATEST',
        secretAccessKey: 'test-secret',
        accountId: '123456789012',
        region: 'us-east-1',
      },
      { providerId: 'aws' },
    );

    const invoices = await adapter.listInvoices(session, {
      since: '2026-03-01',
    });
    const pdf = await adapter.download(session, invoices[0] as InvoiceMeta);

    expect(invoices[0]).toMatchObject({
      vendor: 'aws',
      invoice_no: 'AWS-2026-03-001',
      period: '2026-03',
      net: 100,
      vat: 19,
      gross: 119,
      currency: 'EUR',
    });
    expect(new TextDecoder().decode(pdf)).toBe('%PDF aws');
  });

  test('Azure adapter lists invoices and follows the download URL', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/invoices?')) {
        return new Response(
          JSON.stringify({
            value: [
              {
                name: 'AZ-2026-03-001',
                properties: {
                  invoiceDate: '2026-04-01',
                  dueDate: '2026-04-15',
                  billingPeriodStartDate: '2026-03-01',
                  subTotal: { value: 100 },
                  taxAmount: { value: 19 },
                  totalAmount: { value: 119 },
                  currency: 'EUR',
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes('/download?')) {
        return new Response(
          JSON.stringify({
            url: 'https://azure.example/invoices/pdf-1',
          }),
          { status: 200 },
        );
      }
      return new Response('%PDF azure', { status: 200 });
    });
    const adapter = createAzureInvoiceAdapter({
      fetch: fetchMock as typeof fetch,
    });
    const session = await adapter.login(
      { accessToken: 'token', billingAccountId: 'billing-account' },
      { providerId: 'azure' },
    );

    const invoices = await adapter.listInvoices(session, {
      since: '2026-03-01',
    });
    const pdf = await adapter.download(session, invoices[0] as InvoiceMeta);

    expect(invoices[0]).toMatchObject({
      vendor: 'azure',
      invoice_no: 'AZ-2026-03-001',
      period: '2026-03',
      net: 100,
      vat: 19,
      gross: 119,
    });
    expect(new TextDecoder().decode(pdf)).toBe('%PDF azure');
  });

  test('GCP adapter uses the browser scrape path for Cloud Billing documents', async () => {
    const driver: ScrapeInvoiceDriver = {
      login: vi.fn(async () => undefined),
      listInvoices: vi.fn(async () => [{ ...invoiceMeta, vendor: 'gcp' }]),
      downloadInvoice: vi.fn(async () => new TextEncoder().encode('%PDF gcp')),
    };
    const adapter = createGcpInvoiceAdapter({ driver });
    const session = await adapter.login(
      { username: 'user_a', password: 'password' },
      { providerId: 'gcp', profileDir: '/tmp/gcp-profile' },
    );

    const invoices = await adapter.listInvoices(session, {});
    expect(invoices[0]?.vendor).toBe('gcp');
    await expect(
      adapter.download(session, invoices[0] as InvoiceMeta),
    ).resolves.toBeInstanceOf(Uint8Array);
  });
});

describe('recorded invoice eval fixtures', () => {
  test.each([
    'stripe',
    'github',
    'openai',
    'anthropic',
    'atlassian',
    'linkedin',
    'google-ads',
    'aws',
    'gcp',
    'azure',
  ] satisfies InvoiceProviderId[])('%s fixture replays offline', async (id) => {
    const adapter = new RecordedFixtureInvoiceAdapter({
      id,
      displayName: id,
      fixturePath: new URL(
        `./fixtures/invoices/recorded-${id}.json`,
        import.meta.url,
      ).pathname,
    });
    const session = await adapter.login({}, { providerId: id });
    const invoices = await adapter.listInvoices(session, {
      since: '2026-01-01',
    });
    const pdf = await adapter.download(session, invoices[0] as InvoiceMeta);

    expect(invoices).toHaveLength(1);
    expect(invoices[0]?.vendor).toBe(id);
    expect(new TextDecoder().decode(pdf)).toContain('%PDF');
  });

  test('validates recorded fixtures at construction time', () => {
    const fixturePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'hc-recorded-fixture-')),
      'broken.json',
    );
    fs.writeFileSync(fixturePath, '{broken', 'utf-8');

    expect(
      () =>
        new RecordedFixtureInvoiceAdapter({
          id: 'stripe',
          displayName: 'Stripe',
          fixturePath,
        }),
    ).toThrow(new RegExp(`Invalid recorded invoice fixture at ${fixturePath}`));
  });
});

describe('invoice harvester config and monthly workflow', () => {
  test('validates credential refs for revision-friendly config storage', () => {
    const config = validateInvoiceHarvesterConfig({
      outputDir: '/tmp/invoices',
      providers: [
        {
          id: 'stripe',
          credentials: {
            apiKey: { source: 'store', id: 'STRIPE_INVOICE_API_KEY' },
          },
        },
      ],
      datev: {
        enabled: true,
        workflowId: 'workflow_monthly_invoice_run',
      },
    });

    expect(config.providers[0]?.credentials.apiKey).toEqual({
      source: 'store',
      id: 'STRIPE_INVOICE_API_KEY',
    });
    expect(() =>
      validateInvoiceHarvesterConfig({
        outputDir: '/tmp/invoices',
        providers: [
          { id: 'stripe', credentials: {} },
          { id: 'stripe', credentials: {} },
        ],
      }),
    ).toThrow(/duplicate stripe/u);
    expect(() =>
      validateInvoiceHarvesterConfig({
        outputDir: '/tmp/invoices',
        providers: [
          {
            id: 'stripe',
            since: 'not-a-date',
            credentials: {
              apiKey: { source: 'store', id: 'STRIPE_INVOICE_API_KEY' },
            },
          },
        ],
      }),
    ).toThrow(/since/u);
    expect(() =>
      validateInvoiceHarvesterConfig({
        outputDir: '/tmp/invoices',
        providers: [
          {
            id: 'stripe',
            credentials: {
              apiKey: 'sk_live_cleartext',
            },
          },
        ],
      }),
    ).toThrow(/credentials/u);
  });

  test('composes harvest and DATEV handoff in one monthly run', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-monthly-'));
    const providerOutputDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hc-monthly-provider-'),
    );
    const adapter = new RecordedFixtureInvoiceAdapter({
      id: 'stripe',
      displayName: 'Stripe',
      fixturePath: new URL(
        './fixtures/invoices/recorded-stripe.json',
        import.meta.url,
      ).pathname,
    });
    const datev = { uploadInvoices: vi.fn(async () => undefined) };
    const recordAudit = vi.fn();

    const result = await runMonthlyInvoiceRun({
      sessionId: 'session-monthly-invoice-test',
      adapters: [adapter],
      datev,
      recordAudit,
      config: {
        outputDir,
        providers: [
          { id: 'stripe', outputDir: providerOutputDir, credentials: {} },
        ],
        datev: {
          enabled: true,
          workflowId: 'workflow_monthly_invoice_run',
        },
      },
    });

    expect(result.providerResults).toHaveLength(1);
    expect(result.datevUploaded).toBe(true);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ type: 'invoice.datev_handoff' }),
      }),
    );
    expect(datev.uploadInvoices).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: 'workflow_monthly_invoice_run',
        outputDir,
        invoiceRoots: [
          expect.objectContaining({
            invoice_no: 'ST-2026-03-001',
            outputDir: providerOutputDir,
          }),
        ],
        records: expect.arrayContaining([
          expect.objectContaining({ invoice_no: 'ST-2026-03-001' }),
        ]),
      }),
    );
  });

  test('DATEV Unternehmen Online uploader sends harvested PDFs through a browser driver', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-datev-'));
    const pdfPath = path.join(
      outputDir,
      'runs',
      '2026-03',
      'stripe',
      'ST-2026-03-001.pdf',
    );
    fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
    fs.writeFileSync(pdfPath, '%PDF stripe');
    const record = validateInvoiceRecord({
      ...invoiceMeta,
      vendor: 'stripe',
      invoice_no: 'ST-2026-03-001',
      pdf_path: 'runs/2026-03/stripe/ST-2026-03-001.pdf',
      checksum_sha256:
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    });
    const session = { close: vi.fn(async () => undefined) };
    const driver = {
      login: vi.fn(async () => session),
      uploadInvoice: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const adapter = new DatevUnternehmenOnlineUploadAdapter({
      credentials: { username: 'datev-user', password: 'datev-password' },
      profileDir: '/tmp/datev-profile',
      driver,
    });

    await adapter.uploadInvoices({
      workflowId: 'workflow_monthly_invoice_run',
      records: [record],
      outputDir,
      invoiceRoots: [],
    });

    expect(driver.login).toHaveBeenCalledWith({
      credentials: { username: 'datev-user', password: 'datev-password' },
      profileDir: '/tmp/datev-profile',
    });
    expect(driver.uploadInvoice).toHaveBeenCalledWith(session, {
      record,
      pdfPath,
    });
    expect(driver.close).toHaveBeenCalledWith(session);
  });

  test('keeps monthly runs going after one provider fails', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-monthly-'));
    const failingAdapter: InvoiceAdapter<undefined> = {
      id: 'openai',
      displayName: 'OpenAI',
      async login() {
        throw new Error('portal unavailable');
      },
      async listInvoices() {
        return [];
      },
      async download() {
        return new Uint8Array();
      },
    };
    const workingAdapter = new RecordedFixtureInvoiceAdapter({
      id: 'stripe',
      displayName: 'Stripe',
      fixturePath: new URL(
        './fixtures/invoices/recorded-stripe.json',
        import.meta.url,
      ).pathname,
    });
    const recordAudit = vi.fn();

    const result = await runMonthlyInvoiceRun({
      sessionId: 'session-monthly-invoice-test',
      adapters: [failingAdapter, workingAdapter],
      recordAudit,
      config: {
        outputDir,
        providers: [
          { id: 'openai', credentials: {} },
          { id: 'stripe', credentials: {} },
        ],
      },
    });

    expect(result.providerResults).toHaveLength(1);
    expect(result.providerResults[0]?.providerId).toBe('stripe');
    expect(result.providerErrors).toEqual([
      { providerId: 'openai', error: 'portal unavailable' },
    ]);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          type: 'invoice.provider_failed',
          provider: 'openai',
        }),
      }),
    );
  });
});
