import fs from 'node:fs';
import path from 'node:path';

import { validateInvoiceRecord } from './schema.js';
import type {
  InvoiceHarvestDuplicate,
  InvoiceMeta,
  InvoiceRecord,
} from './types.js';

export interface InvoiceManifest {
  schema: 'hybridclaw.invoice-manifest.v1';
  records: InvoiceRecord[];
}

export function createInvoiceIdentity(invoice: {
  vendor: string;
  invoice_no: string;
}): string {
  return `${invoice.vendor.trim().toLowerCase()}\u0000${invoice.invoice_no.trim()}`;
}

export function loadInvoiceManifest(filePath: string): InvoiceManifest {
  if (!fs.existsSync(filePath)) {
    return { schema: 'hybridclaw.invoice-manifest.v1', records: [] };
  }

  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    (parsed as { schema?: unknown }).schema !== 'hybridclaw.invoice-manifest.v1'
  ) {
    throw new Error(`Invalid invoice manifest at ${filePath}.`);
  }

  const records = (parsed as { records?: unknown }).records;
  if (!Array.isArray(records)) {
    throw new Error(
      `Invalid invoice manifest at ${filePath}: records missing.`,
    );
  }

  return {
    schema: 'hybridclaw.invoice-manifest.v1',
    records: records.map(validateInvoiceRecord),
  };
}

export function saveInvoiceManifest(
  filePath: string,
  manifest: InvoiceManifest,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    `${filePath}.tmp`,
    `${JSON.stringify(manifest, null, 2)}\n`,
    {
      encoding: 'utf-8',
      mode: 0o600,
    },
  );
  fs.renameSync(`${filePath}.tmp`, filePath);
}

export function findInvoiceDuplicate(
  invoice: InvoiceMeta | InvoiceRecord,
  records: InvoiceRecord[],
): InvoiceHarvestDuplicate | null {
  const identity = createInvoiceIdentity(invoice);
  const identityMatch = records.find(
    (record) => createInvoiceIdentity(record) === identity,
  );
  if (identityMatch) {
    return { reason: 'identity', invoice };
  }

  if ('checksum_sha256' in invoice) {
    const checksumMatch = records.find(
      (record) => record.checksum_sha256 === invoice.checksum_sha256,
    );
    if (checksumMatch) {
      return { reason: 'checksum', invoice };
    }
  }

  return null;
}
