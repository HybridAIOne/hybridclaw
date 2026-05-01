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
  }): Promise<void>;
}

export interface MonthlyInvoiceRunResult {
  runId: string;
  providerResults: Array<{
    providerId: InvoiceProviderId;
    result: InvoiceHarvestResult;
  }>;
  datevUploaded: boolean;
}

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
}): Promise<MonthlyInvoiceRunResult> {
  const runId = makeAuditRunId('monthly-invoice');
  const audit = input.recordAudit || recordAuditEvent;
  const adaptersById = adapterMap(input.adapters);
  const providerResults: MonthlyInvoiceRunResult['providerResults'] = [];

  for (const provider of enabledProviders(input.config)) {
    const adapter = adaptersById.get(provider.id);
    if (!adapter) {
      throw new Error(`Invoice adapter ${provider.id} is not registered.`);
    }
    const outputDir = provider.outputDir || input.config.outputDir;
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
  }

  const records = providerResults.flatMap(({ result }) => result.fetched);
  const shouldUpload = Boolean(input.config.datev?.enabled);
  if (shouldUpload) {
    if (!input.datev) {
      throw new Error(
        'DATEV handoff is enabled but no upload adapter was provided.',
      );
    }
    await input.datev.uploadInvoices({
      workflowId: input.config.datev?.workflowId || 'monthly-invoice-run',
      records,
      outputDir: input.config.outputDir,
    });
    audit({
      sessionId: input.sessionId,
      runId,
      event: {
        type: 'invoice.datev_handoff',
        workflowId: input.config.datev?.workflowId,
        invoiceCount: records.length,
      },
    });
  }

  return {
    runId,
    providerResults,
    datevUploaded: shouldUpload,
  };
}
