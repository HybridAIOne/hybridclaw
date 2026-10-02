/**
 * Plugin config validation against a plugin's JSON Schema (Ajv).
 *
 * Loading strips keys the schema does not declare (`additionalProperties:
 * false`), so a stale override never stops a plugin from starting. Writing
 * rejects them, so `plugin config` never saves a key the plugin will not see.
 *
 * NOT the config write path (`plugin-config.ts` reads and saves runtime config)
 * and does not decide which schema applies (`plugin-manager.ts` resolves it).
 */
import { Ajv, type AnySchemaObject, type ErrorObject } from 'ajv';
import { normalizeTrimmedString } from '../utils/normalized-strings.js';
import { isRecord } from '../utils/type-guards.js';
import type { PluginConfigSchema } from './plugin-types.js';

const AJV_OPTIONS = {
  allErrors: false,
  strictSchema: true,
  strictTypes: false,
  useDefaults: true,
} as const;

const pluginConfigValidator = new Ajv({
  ...AJV_OPTIONS,
  removeAdditional: true,
});
const declaredKeysValidator = new Ajv(AJV_OPTIONS);

function decodeJsonPointerSegment(value: string): string {
  return value.replaceAll('~1', '/').replaceAll('~0', '~');
}

// `/auth/0/token` -> `.auth[0].token`
function formatAjvInstancePath(instancePath: string): string {
  const segments = instancePath
    .split('/')
    .slice(1)
    .map(decodeJsonPointerSegment);
  let output = '';
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
  const pointer = `plugin config${formatAjvInstancePath(error.instancePath)}`;
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

/**
 * Write-path check: validates `config` as loading does, then throws unless the
 * plugin would see `config[key]` exactly as written, i.e. neither `key` nor a
 * property nested in its value would be stripped. Other keys are not held to
 * this, so an undeclared key saved earlier does not block writes or `--unset`.
 */
export function assertPluginConfigKeyDeclared(params: {
  pluginId: string;
  schema: PluginConfigSchema | undefined;
  config: Record<string, unknown>;
  key: string;
}): void {
  const { pluginId, schema, config, key } = params;
  const loaded = validatePluginConfig(schema, config);
  if (!schema) return;
  // The schema compiled above with the same options except removeAdditional.
  const validate = declaredKeysValidator.compile(schema as AnySchemaObject);
  if (validate({ ...loaded, [key]: structuredClone(config[key]) })) return;

  const [error] = validate.errors || [];
  if (!error) throw new Error('Plugin config is invalid.');
  if (error.keyword !== 'additionalProperties') {
    throw new Error(formatAjvValidationError(error));
  }
  const property = String(error.params.additionalProperty);
  // Drop the leading `.` of the formatted path: `.auth.extra` -> `auth.extra`.
  const keyPath = `${formatAjvInstancePath(error.instancePath)}.${property}`;
  throw new Error(
    `Plugin \`${pluginId}\` does not declare config key \`${keyPath.slice(1)}\`.`,
  );
}
