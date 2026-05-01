import fs from 'node:fs';
import path from 'node:path';

import { Ajv, type AnySchemaObject } from 'ajv';
import { validateInvoiceRecord } from './schema.js';
import { formatJsonSchemaError } from './schema-error.js';
import type {
  InvoiceHarvestDuplicate,
  InvoiceMeta,
  InvoiceRecord,
} from './types.js';

export interface InvoiceManifest {
  schema: 'hybridclaw.invoice-manifest.v1';
  records: InvoiceRecord[];
}

const INVOICE_MANIFEST_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'urn:hybridclaw:schema:invoice-manifest',
  type: 'object',
  additionalProperties: false,
  required: ['schema', 'records'],
  properties: {
    schema: { type: 'string', const: 'hybridclaw.invoice-manifest.v1' },
    records: { type: 'array' },
  },
} satisfies AnySchemaObject;

const invoiceManifestValidator = new Ajv({
  allErrors: true,
  removeAdditional: false,
  strictSchema: true,
}).compile<{ schema: 'hybridclaw.invoice-manifest.v1'; records: unknown[] }>(
  INVOICE_MANIFEST_SCHEMA,
);

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

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid invoice manifest at ${filePath}: ${(error as Error).message}`,
    );
  }

  if (!invoiceManifestValidator(parsed)) {
    const message = (invoiceManifestValidator.errors || [])
      .map(formatJsonSchemaError)
      .join(' ');
    throw new Error(`Invalid invoice manifest at ${filePath}: ${message}`);
  }

  return {
    schema: 'hybridclaw.invoice-manifest.v1',
    records: parsed.records.map(validateInvoiceRecord),
  };
}

export function saveInvoiceManifest(
  filePath: string,
  manifest: InvoiceManifest,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempFilePath = `${filePath}.${process.pid}.${Date.now()}.${Math.random()
    .toString(16)
    .slice(2)}.tmp`;

  try {
    fs.writeFileSync(tempFilePath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
    fs.renameSync(tempFilePath, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    } catch {
      // Best-effort cleanup only.
    }
    throw error;
  }
}

export interface InvoiceDuplicateIndex {
  identities: Set<string>;
  checksums: Set<string>;
}

export function createInvoiceDuplicateIndex(
  records: InvoiceRecord[],
): InvoiceDuplicateIndex {
  return {
    identities: new Set(records.map(createInvoiceIdentity)),
    checksums: new Set(records.map((record) => record.checksum_sha256)),
  };
}

export function addInvoiceRecordToDuplicateIndex(
  index: InvoiceDuplicateIndex,
  record: InvoiceRecord,
): void {
  index.identities.add(createInvoiceIdentity(record));
  index.checksums.add(record.checksum_sha256);
}

export function findInvoiceDuplicateInIndex(
  invoice: InvoiceMeta | InvoiceRecord,
  index: InvoiceDuplicateIndex,
): InvoiceHarvestDuplicate | null {
  if (index.identities.has(createInvoiceIdentity(invoice))) {
    return { reason: 'identity', invoice };
  }
  if (
    'checksum_sha256' in invoice &&
    index.checksums.has(invoice.checksum_sha256)
  ) {
    return { reason: 'checksum', invoice };
  }
  return null;
}
