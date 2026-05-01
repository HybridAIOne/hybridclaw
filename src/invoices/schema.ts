import { Ajv, type AnySchemaObject, type ErrorObject } from 'ajv';
import type { InvoiceRecord } from './types.js';

const ISO_DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';
const INVOICE_PERIOD_PATTERN = '^\\d{4}-\\d{2}$';
const SHA256_PATTERN = '^[a-f0-9]{64}$';

export const INVOICE_RECORD_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'urn:hybridclaw:schema:invoice-record',
  title: 'HybridClaw normalized invoice record',
  type: 'object',
  additionalProperties: false,
  required: [
    'vendor',
    'invoice_no',
    'period',
    'issue_date',
    'due_date',
    'net',
    'vat_rate',
    'vat',
    'gross',
    'currency',
    'pdf_path',
    'source_url',
    'checksum_sha256',
  ],
  properties: {
    vendor: { type: 'string', minLength: 1 },
    invoice_no: { type: 'string', minLength: 1 },
    period: { type: 'string', pattern: INVOICE_PERIOD_PATTERN },
    issue_date: { type: 'string', pattern: ISO_DATE_PATTERN },
    due_date: { type: 'string', pattern: ISO_DATE_PATTERN },
    net: { type: 'number' },
    vat_rate: { type: 'number', minimum: 0, maximum: 1 },
    vat: { type: 'number' },
    gross: { type: 'number' },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    pdf_path: { type: 'string', minLength: 1 },
    source_url: { type: 'string', minLength: 1 },
    checksum_sha256: { type: 'string', pattern: SHA256_PATTERN },
  },
} satisfies AnySchemaObject;

const invoiceRecordValidator = new Ajv({
  allErrors: true,
  removeAdditional: false,
  strictSchema: true,
}).compile<InvoiceRecord>(INVOICE_RECORD_SCHEMA);

function formatJsonSchemaError(error: ErrorObject): string {
  const pointer = error.instancePath || '/';
  if (
    error.keyword === 'required' &&
    typeof error.params.missingProperty === 'string'
  ) {
    return `${pointer} must include ${error.params.missingProperty}.`;
  }
  if (
    error.keyword === 'additionalProperties' &&
    typeof error.params.additionalProperty === 'string'
  ) {
    return `${pointer} must not include ${error.params.additionalProperty}.`;
  }
  if (error.keyword === 'pattern') {
    return `${pointer} has invalid format.`;
  }
  if (error.keyword === 'minimum' || error.keyword === 'maximum') {
    return `${pointer} ${error.message || 'is out of range'}.`;
  }
  return `${pointer} ${error.message || 'is invalid'}.`;
}

export function validateInvoiceRecord(value: unknown): InvoiceRecord {
  if (!invoiceRecordValidator(value)) {
    const message = (invoiceRecordValidator.errors || [])
      .map(formatJsonSchemaError)
      .join(' ');
    throw new Error(`Invalid invoice record: ${message}`);
  }
  return value;
}
