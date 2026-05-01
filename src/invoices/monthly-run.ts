import path from 'node:path';

import {
  makeAuditRunId,
  type RecordAuditEventInput,
  recordAuditEvent,
} from '../audit/audit-events.js';
import type {
  InvoiceHarvesterConfig,
  InvoiceProviderConfig,
} from './config.js';
import { resolveInvoiceCredentials } from './credentials.js';
import { harvestProviderInvoices } from './harvester.js';
import type {
  InvoiceAdapter,
  InvoiceHarvestResult,
  InvoiceProviderId,
  InvoiceRecord,
} from './types.js';

export interface DatevInvoiceUploadAdapter {
  uploadInvoices(params: {
    workflowId: string;
    records: InvoiceRecord[];
    outputDir: string;
    invoiceRoots: Array<{
      vendor: string;
      invoice_no: string;
      outputDir: string;
    }>;
  }): Promise<void>;
}

export interface MonthlyInvoiceRunResult {
  runId: string;
  providerResults: Array<{
    providerId: InvoiceProviderId;
    result: InvoiceHarvestResult;
  }>;
  providerErrors: Array<{
    providerId: InvoiceProviderId;
    error: string;
  }>;
  datevUploaded: boolean;
}

const SCRAPE_PROVIDER_IDS = new Set<InvoiceProviderId>([
  'github',
  'openai',
  'anthropic',
  'atlassian',
  'linkedin',
]);

function adapterMap(
  adapters: InvoiceAdapter[],
): Map<string, InvoiceAdapter<unknown>> {
  return new Map(
    adapters.map((adapter) => [adapter.id, adapter as InvoiceAdapter<unknown>]),
  );
}

function enabledProviders(
  config: InvoiceHarvesterConfig,
): InvoiceProviderConfig[] {
  return config.providers.filter((provider) => provider.enabled !== false);
}

export async function runMonthlyInvoiceRun(input: {
  config: InvoiceHarvesterConfig;
  adapters: InvoiceAdapter[];
  sessionId: string;
  datev?: DatevInvoiceUploadAdapter;
  recordAudit?: (input: RecordAuditEventInput) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  scrapeJitterMs?: { min: number; max: number };
}): Promise<MonthlyInvoiceRunResult> {
  const runId = makeAuditRunId('monthly-invoice');
  const audit = input.recordAudit || recordAuditEvent;
  const adaptersById = adapterMap(input.adapters);
  const providerResults: MonthlyInvoiceRunResult['providerResults'] = [];
  const providerErrors: MonthlyInvoiceRunResult['providerErrors'] = [];
  const invoiceRoots: Array<{
    vendor: string;
    invoice_no: string;
    outputDir: string;
  }> = [];
  const providers = enabledProviders(input.config);

  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index] as InvoiceProviderConfig;
    const adapter = adaptersById.get(provider.id);
    if (!adapter) {
      throw new Error(`Invoice adapter ${provider.id} is not registered.`);
    }
    const outputDir = provider.outputDir || input.config.outputDir;
    try {
      const credentials = resolveInvoiceCredentials(
        provider.id,
        provider.credentials,
        {
          required: [],
          audit: () => {
            audit({
              sessionId: input.sessionId,
              runId,
              event: {
                type: 'invoice.credential_resolved',
                provider: provider.id,
              },
            });
          },
        },
      );
      const result = await harvestProviderInvoices({
        adapter,
        credentials,
        outputDir,
        manifestPath: path.join(outputDir, 'manifest.json'),
        listOptions: { since: provider.since },
        profileDir: provider.profileDir,
        sessionId: input.sessionId,
        runId,
        recordAudit: audit,
      });
      providerResults.push({ providerId: provider.id, result });
      invoiceRoots.push(
        ...result.fetched.map((record) => ({
          vendor: record.vendor,
          invoice_no: record.invoice_no,
          outputDir,
        })),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      providerErrors.push({ providerId: provider.id, error: message });
      audit({
        sessionId: input.sessionId,
        runId,
        event: {
          type: 'invoice.provider_failed',
          provider: provider.id,
          error: message,
        },
      });
    }

    if (
      index < providers.length - 1 &&
      SCRAPE_PROVIDER_IDS.has(provider.id) &&
      SCRAPE_PROVIDER_IDS.has(providers[index + 1]?.id as InvoiceProviderId)
    ) {
      const jitter = input.scrapeJitterMs || { min: 250, max: 1250 };
      const random = input.random || Math.random;
      const sleep =
        input.sleep ||
        ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
      const delay =
        jitter.min + Math.floor(random() * (jitter.max - jitter.min + 1));
      await sleep(delay);
    }
  }

  const records = providerResults.flatMap(({ result }) => result.fetched);
  const shouldUpload = Boolean(input.config.datev?.enabled);
  if (shouldUpload) {
    if (!input.datev) {
      throw new Error(
        'DATEV handoff is enabled but no upload adapter was provided.',
      );
    }
    const workflowId = input.config.datev?.workflowId || 'monthly-invoice-run';
    await input.datev.uploadInvoices({
      workflowId,
      records,
      outputDir: input.config.outputDir,
      invoiceRoots,
    });
    audit({
      sessionId: input.sessionId,
      runId,
      event: {
        type: 'invoice.datev_handoff',
        workflowId,
        invoiceCount: records.length,
      },
    });
  }

  return {
    runId,
    providerResults,
    providerErrors,
    datevUploaded: shouldUpload,
  };
}
