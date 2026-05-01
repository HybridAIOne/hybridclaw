import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { emitInvoiceFetchedAudit, type InvoiceAuditRecorder } from './audit.js';
import {
  addInvoiceRecordToDuplicateIndex,
  createInvoiceDuplicateIndex,
  findInvoiceDuplicateInIndex,
  loadInvoiceManifest,
  saveInvoiceManifest,
} from './idempotency.js';
import { validateInvoiceRecord } from './schema.js';
import type {
  InvoiceAdapter,
  InvoiceCredentials,
  InvoiceHarvestDuplicate,
  InvoiceHarvestResult,
  InvoiceListOptions,
  InvoiceMeta,
  InvoiceRecord,
} from './types.js';

type Closeable = {
  close?: () => void | Promise<void>;
};

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function safePathPart(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'invoice';
}

function invoicePdfRelativePath(invoice: InvoiceMeta): string {
  const fileName = safePathPart(`${invoice.invoice_no}.pdf`);
  const pdfName = fileName.endsWith('.pdf') ? fileName : `${fileName}.pdf`;
  return path.posix.join(
    'runs',
    invoice.period,
    safePathPart(invoice.vendor),
    pdfName,
  );
}

function writeInvoicePdf(
  outputDir: string,
  relativePath: string,
  bytes: Uint8Array,
): void {
  const targetPath = path.resolve(outputDir, relativePath);
  const outputRoot = path.resolve(outputDir);
  if (!targetPath.startsWith(outputRoot + path.sep)) {
    throw new Error(
      `Invoice PDF path escapes output directory: ${relativePath}`,
    );
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(targetPath, bytes, { mode: 0o600 });
}

export function buildInvoiceRecord(input: {
  invoice: InvoiceMeta;
  pdfPath: string;
  checksumSha256: string;
}): InvoiceRecord {
  return validateInvoiceRecord({
    ...input.invoice,
    pdf_path: input.pdfPath,
    checksum_sha256: input.checksumSha256,
  });
}

export async function harvestProviderInvoices<Session>(input: {
  adapter: InvoiceAdapter<Session>;
  credentials: InvoiceCredentials;
  outputDir: string;
  manifestPath?: string;
  listOptions?: InvoiceListOptions;
  profileDir?: string;
  sessionId?: string;
  runId?: string;
  recordAudit?: InvoiceAuditRecorder;
}): Promise<InvoiceHarvestResult> {
  const manifestPath =
    input.manifestPath || path.join(input.outputDir, 'manifest.json');
  const manifest = loadInvoiceManifest(manifestPath);
  const duplicateIndex = createInvoiceDuplicateIndex(manifest.records);
  const duplicates: InvoiceHarvestDuplicate[] = [];
  const fetched: InvoiceRecord[] = [];
  let session: Session | undefined;

  try {
    session = await input.adapter.login(input.credentials, {
      providerId: input.adapter.id,
      profileDir: input.profileDir,
    });
    const invoices = await input.adapter.listInvoices(
      session,
      input.listOptions || {},
    );

    for (const invoice of invoices) {
      const identityDuplicate = findInvoiceDuplicateInIndex(
        invoice,
        duplicateIndex,
      );
      if (identityDuplicate) {
        duplicates.push(identityDuplicate);
        continue;
      }

      const bytes = await input.adapter.download(session, invoice);
      const relativePath = invoicePdfRelativePath(invoice);
      const record = buildInvoiceRecord({
        invoice,
        pdfPath: relativePath,
        checksumSha256: sha256(bytes),
      });
      const checksumDuplicate = findInvoiceDuplicateInIndex(
        record,
        duplicateIndex,
      );
      if (checksumDuplicate) {
        duplicates.push(checksumDuplicate);
        continue;
      }

      writeInvoicePdf(input.outputDir, relativePath, bytes);
      fetched.push(record);
      addInvoiceRecordToDuplicateIndex(duplicateIndex, record);
      if (input.sessionId) {
        emitInvoiceFetchedAudit({
          sessionId: input.sessionId,
          runId: input.runId,
          record,
          recordAudit: input.recordAudit,
        });
      }
    }

    if (fetched.length > 0) {
      manifest.records.push(...fetched);
      saveInvoiceManifest(manifestPath, manifest);
    } else if (!fs.existsSync(manifestPath)) {
      saveInvoiceManifest(manifestPath, manifest);
    }

    return {
      fetched,
      duplicates,
      manifestPath,
    };
  } finally {
    if (session !== undefined) {
      if (typeof input.adapter.close === 'function') {
        await input.adapter.close(session);
      } else {
        await (session as Closeable).close?.();
      }
    }
  }
}
