import type { ErrorObject } from 'ajv';

export function formatJsonSchemaError(error: ErrorObject): string {
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
  if (error.keyword === 'pattern') {
    return `${pointer} has invalid format.`;
  }
  if (error.keyword === 'minimum' || error.keyword === 'maximum') {
    return `${pointer} ${error.message || 'is out of range'}.`;
  }
  return `${pointer} ${error.message || 'is invalid'}.`;
}
