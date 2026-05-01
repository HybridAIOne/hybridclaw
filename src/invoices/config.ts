import { Ajv, type AnySchemaObject } from 'ajv';
import type { SecretInput } from '../security/secret-refs.js';
import { formatJsonSchemaError } from './schema-error.js';
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
    {
      type: 'string',
      pattern: '^\\$\\{[A-Za-z_][A-Za-z0-9_]*\\}$',
    },
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
          since: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
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
