const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');

const schemaPath = path.join(__dirname, '..', 'schema.json');
const INVOICE_RECORD_SCHEMA = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

const validator = new Ajv({
  allErrors: true,
  removeAdditional: false,
  strictSchema: true,
}).compile(INVOICE_RECORD_SCHEMA);

function formatJsonSchemaError(error) {
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
  if (error.keyword === 'enum' && Array.isArray(error.schema)) {
    return `${pointer} must be one of ${error.schema.join(', ')}.`;
  }
  if (error.keyword === 'pattern') return `${pointer} has invalid format.`;
  if (error.keyword === 'minimum' || error.keyword === 'maximum') {
    return `${pointer} ${error.message || 'is out of range'}.`;
  }
  return `${pointer} ${error.message || 'is invalid'}.`;
}

function validateInvoiceRecord(value) {
  if (!validator(value)) {
    const message = (validator.errors || []).map(formatJsonSchemaError).join(' ');
    throw new Error(`Invalid invoice record: ${message}`);
  }
  return value;
}

module.exports = {
  INVOICE_RECORD_SCHEMA,
  formatJsonSchemaError,
  validateInvoiceRecord,
};
