import { Ajv, type AnySchemaObject, type ErrorObject } from 'ajv';
import type { RuntimeConfigChangeMeta } from '../config/runtime-config-revisions.js';
import type { SecretInput } from '../security/secret-refs.js';
import { INVOICE_PROVIDER_IDS, type InvoiceProviderId } from './types.js';

export interface InvoiceProviderConfig {
  id: InvoiceProviderId;
  enabled?: boolean;
  outputDir?: string;
  profileDir?: string;
  since?: string;
  credentials: Record<string, SecretInput>;
}

export interface DatevHandoffConfig {
  enabled: boolean;
  workflowId: string;
}

export interface InvoiceHarvesterConfig {
  outputDir: string;
  providers: InvoiceProviderConfig[];
  datev?: DatevHandoffConfig;
}

const secretInputSchema = {
  oneOf: [
    { type: 'string', minLength: 1 },
    {
      type: 'object',
      additionalProperties: false,
      required: ['source', 'id'],
      properties: {
        source: { type: 'string', enum: ['env', 'store'] },
        id: { type: 'string', minLength: 1 },
      },
    },
  ],
} satisfies AnySchemaObject;

export const INVOICE_HARVESTER_CONFIG_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'urn:hybridclaw:schema:invoice-harvester-config',
  title: 'HybridClaw invoice harvester config',
  type: 'object',
  additionalProperties: false,
  required: ['outputDir', 'providers'],
  properties: {
    outputDir: { type: 'string', minLength: 1 },
    providers: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'credentials'],
        properties: {
          id: { type: 'string', enum: INVOICE_PROVIDER_IDS },
          enabled: { type: 'boolean' },
          outputDir: { type: 'string', minLength: 1 },
          profileDir: { type: 'string', minLength: 1 },
          since: { type: 'string', minLength: 1 },
          credentials: {
            type: 'object',
            additionalProperties: secretInputSchema,
          },
        },
      },
    },
    datev: {
      type: 'object',
      additionalProperties: false,
      required: ['enabled', 'workflowId'],
      properties: {
        enabled: { type: 'boolean' },
        workflowId: { type: 'string', minLength: 1 },
      },
    },
  },
} satisfies AnySchemaObject;

const invoiceConfigValidator = new Ajv({
  allErrors: true,
  removeAdditional: false,
  strictSchema: true,
}).compile<InvoiceHarvesterConfig>(INVOICE_HARVESTER_CONFIG_SCHEMA);

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
  if (error.keyword === 'enum' && Array.isArray(error.schema)) {
    return `${pointer} must be one of ${error.schema.join(', ')}.`;
  }
  return `${pointer} ${error.message || 'is invalid'}.`;
}

function assertUniqueProviders(config: InvoiceHarvesterConfig): void {
  const seen = new Set<string>();
  for (const provider of config.providers) {
    if (seen.has(provider.id)) {
      throw new Error(
        `Invalid invoice harvester config: duplicate ${provider.id}.`,
      );
    }
    seen.add(provider.id);
  }
}

export function validateInvoiceHarvesterConfig(
  value: unknown,
): InvoiceHarvesterConfig {
  if (!invoiceConfigValidator(value)) {
    const message = (invoiceConfigValidator.errors || [])
      .map(formatJsonSchemaError)
      .join(' ');
    throw new Error(`Invalid invoice harvester config: ${message}`);
  }
  assertUniqueProviders(value);
  return value;
}

export async function syncInvoiceHarvesterConfigRevision(
  configPath: string,
  meta?: RuntimeConfigChangeMeta,
): Promise<void> {
  const { syncRuntimeAssetRevisionState } = await import(
    '../config/runtime-config.js'
  );
  syncRuntimeAssetRevisionState(
    'config',
    configPath,
    meta || {
      route: 'invoice-harvester.config',
      source: 'invoice-harvester',
    },
  );
}
