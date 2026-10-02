/**
 * Plugin config validation against a plugin's JSON Schema (Ajv).
 *
 * Loading strips keys the schema does not declare (`additionalProperties:
 * false`), so a stale override never stops a plugin from starting.
 *
 * NOT the config write path (`plugin-config.ts` reads and saves runtime config)
 * and does not decide which schema applies (`plugin-manager.ts` resolves it).
 */
import { Ajv, type AnySchemaObject, type ErrorObject } from 'ajv';
import { normalizeTrimmedString } from '../utils/normalized-strings.js';
import { isRecord } from '../utils/type-guards.js';
import type { PluginConfigSchema } from './plugin-types.js';

const pluginConfigValidator = new Ajv({
  allErrors: false,
  removeAdditional: true,
  strictSchema: true,
  strictTypes: false,
  useDefaults: true,
});

function decodeJsonPointerSegment(value: string): string {
  return value.replaceAll('~1', '/').replaceAll('~0', '~');
}

function formatAjvInstancePath(instancePath: string): string {
  if (!instancePath) return 'plugin config';
  const segments = instancePath
    .split('/')
    .slice(1)
    .map(decodeJsonPointerSegment);
  let output = 'plugin config';
  for (const segment of segments) {
    if (/^\d+$/.test(segment)) {
      output += `[${segment}]`;
      continue;
    }
    output += `.${segment}`;
  }
  return output;
}

function formatAjvValidationError(error: ErrorObject): string {
  const pointer = formatAjvInstancePath(error.instancePath);
  if (error.keyword === 'required') {
    const missingProperty = isRecord(error.params)
      ? normalizeTrimmedString(error.params.missingProperty)
      : undefined;
    if (missingProperty) {
      return `${pointer}.${missingProperty} is required.`;
    }
  }
  if (error.keyword === 'enum' && Array.isArray(error.schema)) {
    return `${pointer} must be one of ${error.schema.join(', ')}.`;
  }
  if (error.keyword === 'additionalProperties') {
    const additionalProperty = isRecord(error.params)
      ? normalizeTrimmedString(error.params.additionalProperty)
      : undefined;
    if (additionalProperty) {
      return `${pointer}.${additionalProperty} is not allowed.`;
    }
  }
  return `${pointer} ${error.message || 'is invalid'}.`;
}

export function validatePluginConfig(
  schema: PluginConfigSchema | undefined,
  value: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!schema) return structuredClone(value || {});
  let validate: ReturnType<typeof pluginConfigValidator.compile>;
  try {
    validate = pluginConfigValidator.compile(schema as AnySchemaObject);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error || 'Unknown error');
    throw new Error(`Invalid plugin config schema: ${message}`);
  }

  const normalized = structuredClone(value || {});
  if (!validate(normalized)) {
    const [firstError] = validate.errors || [];
    if (firstError) {
      throw new Error(formatAjvValidationError(firstError));
    }
    throw new Error('Plugin config is invalid.');
  }

  if (!isRecord(normalized)) {
    throw new Error('Plugin config schema must resolve to an object.');
  }
  return normalized;
}
