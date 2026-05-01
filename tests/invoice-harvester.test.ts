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
  harvestProviderInvoices,
  INVOICE_PROVIDER_DEFINITIONS,
  INVOICE_SCRAPE_PLANS,
  loadInvoiceManifest,
  parseInvoiceMoneyText,
  RecordedFixtureInvoiceAdapter,
  resolveInvoiceCredentials,
  runMonthlyInvoiceRun,
  saveInvoiceManifest,
  StripeInvoiceAdapter,
  validateInvoiceHarvesterConfig,
  validateInvoiceRecord,
  type InvoiceApiClient,
  type InvoiceAdapter,
  type InvoiceMeta,
  type InvoiceProviderId,
  type ScrapeInvoiceDriver,
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
  suggested_file_name: 'OA-2026-03-001.pdf',
};

afterEach(() => {
  delete process.env.HYBRIDCLAW_INVOICE_TEST_SECRET;
  vi.restoreAllMocks();
});

describe('invoice schema', () => {
  test('validates the normalized invoice record contract', () => {
    const normalized = { ...invoiceMeta };
    delete normalized.suggested_file_name;
    const record = validateInvoiceRecord({
      ...normalized,
      pdf_path: 'runs/2026-03/openai/OA-2026-03-001.pdf',
      checksum_sha256:
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    });

    expect(record.vendor).toBe('openai');
    expect(() =>
      validateInvoiceRecord({ ...record, vat_rate: 1.5 }),
    ).toThrow(/vat_rate/u);
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
});

describe('reference invoice adapters', () => {
  test('declares the launch provider set and credential handles', () => {
    expect(INVOICE_PROVIDER_DEFINITIONS.map((provider) => provider.id)).toEqual([
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
    ]);
    expect(
      INVOICE_PROVIDER_DEFINITIONS.find((provider) => provider.id === 'stripe'),
    ).toMatchObject({
      mode: 'api',
      status: 'available',
      credentialKeys: ['apiKey'],
    });
  });

  test('declares provider-specific scrape plans for dashboard adapters', () => {
    expect(Object.keys(INVOICE_SCRAPE_PLANS).sort()).toEqual([
      'anthropic',
      'atlassian',
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
    const adapter = new StripeInvoiceAdapter({ fetch: fetchMock as typeof fetch });
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
    const adapter = new StripeInvoiceAdapter({ fetch: fetchMock as typeof fetch });
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
  });

  test('scrape adapters use injected browser drivers for offline fixtures', async () => {
    const driver: ScrapeInvoiceDriver = {
      login: vi.fn(async () => undefined),
      listInvoices: vi.fn(async () => [invoiceMeta]),
      downloadInvoice: vi.fn(async () => new TextEncoder().encode('%PDF openai')),
    };
    const adapter = createGitHubInvoiceAdapter({ driver });
    const session = await adapter.login(
      { username: 'user_a' },
      { providerId: 'github', profileDir: '/tmp/github-profile' },
    );

    await expect(adapter.listInvoices(session, {})).resolves.toEqual([
      invoiceMeta,
    ]);
    await expect(adapter.download(session, invoiceMeta)).resolves.toBeInstanceOf(
      Uint8Array,
    );
    expect(driver.login).toHaveBeenCalledWith(
      { username: 'user_a' },
      { providerId: 'github', profileDir: '/tmp/github-profile' },
    );
  });

  test('scrape adapters fail loudly when no browser driver is configured', async () => {
    const adapter = createGitHubInvoiceAdapter();

    await expect(
      adapter.login({}, { providerId: 'github' }),
    ).rejects.toThrow(/requires a Playwright driver/u);
  });

  test('API adapters run through injected clients for launch providers', async () => {
    const client: InvoiceApiClient = {
      listInvoices: vi.fn(async ({ context }) => [
        {
          ...invoiceMeta,
          vendor: context.providerId,
          invoice_no: `${context.providerId}-2026-03-001`,
        },
      ]),
      downloadInvoice: vi.fn(async () => new TextEncoder().encode('%PDF api')),
    };
    const adapters = [
      createGoogleAdsInvoiceAdapter(client),
      createAwsInvoiceAdapter(client),
      createGcpInvoiceAdapter(client),
      createAzureInvoiceAdapter(client),
    ];

    for (const adapter of adapters) {
      const session = await adapter.login(
        {
          accessToken: 'token',
          developerToken: 'developer',
          customerId: 'customer',
          accessKeyId: 'key',
          secretAccessKey: 'secret',
          region: 'eu-central-1',
          billingAccountId: 'billing',
        },
        { providerId: adapter.id },
      );

      const invoices = await adapter.listInvoices(session, {});
      expect(invoices[0]?.vendor).toBe(adapter.id);
      await expect(
        adapter.download(session, invoices[0] as InvoiceMeta),
      ).resolves.toBeInstanceOf(Uint8Array);
    }
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
    const invoices = await adapter.listInvoices(session, { since: '2026-01-01' });
    const pdf = await adapter.download(session, invoices[0] as InvoiceMeta);

    expect(invoices).toHaveLength(1);
    expect(invoices[0]?.vendor).toBe(id);
    expect(new TextDecoder().decode(pdf)).toContain('%PDF');
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
});
