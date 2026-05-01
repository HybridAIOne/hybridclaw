const INVOICE_PROVIDER_IDS = [
  'stripe',
  'github',
  'openai',
  'anthropic',
  'atlassian',
  'linkedin',
  'google-ads',
  'aws',
  'gcp',
  'azure',
];

function validateInvoiceHarvesterConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid invoice harvester config: / must be object.');
  }
  if (typeof value.outputDir !== 'string' || !value.outputDir) {
    throw new Error('Invalid invoice harvester config: /outputDir is invalid.');
  }
  if (!Array.isArray(value.providers) || value.providers.length === 0) {
    throw new Error('Invalid invoice harvester config: /providers is invalid.');
  }
  const seen = new Set();
  for (const provider of value.providers) {
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
      throw new Error('Invalid invoice harvester config: /providers is invalid.');
    }
    if (!INVOICE_PROVIDER_IDS.includes(provider.id)) {
      throw new Error('Invalid invoice harvester config: /providers/id is invalid.');
    }
    if (seen.has(provider.id)) {
      throw new Error(`Invalid invoice harvester config: duplicate ${provider.id}.`);
    }
    seen.add(provider.id);
    if (provider.since && !/^\d{4}-\d{2}-\d{2}$/u.test(provider.since)) {
      throw new Error('Invalid invoice harvester config: /providers/since has invalid format.');
    }
    if (!provider.credentials || typeof provider.credentials !== 'object') {
      throw new Error('Invalid invoice harvester config: /providers/credentials is invalid.');
    }
    for (const [key, credential] of Object.entries(provider.credentials)) {
      if (typeof credential === 'string') {
        if (!/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/u.test(credential)) {
          throw new Error(
            `Invalid invoice harvester config: /providers/credentials/${key} must be a secret ref.`,
          );
        }
      } else if (
        !credential ||
        typeof credential !== 'object' ||
        !['env', 'store'].includes(credential.source) ||
        typeof credential.id !== 'string' ||
        !credential.id
      ) {
        throw new Error(
          `Invalid invoice harvester config: /providers/credentials/${key} is invalid.`,
        );
      }
    }
  }
  return value;
}

function resolveInvoiceCredentials(providerId, inputs, opts = {}) {
  const required = new Set(opts.required || []);
  const resolved = {};
  for (const [key, value] of Object.entries(inputs || {})) {
    if (value === undefined) continue;
    const secret = resolveSecretInput(providerId, key, value);
    if (secret) {
      resolved[key] = secret;
      opts.audit?.(
        { source: typeof value === 'object' ? value.source : 'env', id: secretId(value) },
        `resolve ${providerId} invoice credential ${key}`,
      );
    }
  }
  for (const key of required) {
    if (!resolved[key]) {
      throw new Error(`Missing required ${providerId} invoice credential ${key}.`);
    }
  }
  return resolved;
}

function resolveSecretInput(providerId, key, value) {
  const id = secretId(value);
  if (!id) return null;
  const secret = process.env[id];
  if (!secret) {
    throw new Error(
      `Missing ${providerId} invoice credential ${key}: environment secret ${id} is not set.`,
    );
  }
  return secret;
}

function secretId(value) {
  if (typeof value === 'string') {
    const match = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u);
    return match?.[1] || null;
  }
  if (value && typeof value === 'object' && typeof value.id === 'string') {
    return value.id;
  }
  return null;
}

module.exports = {
  INVOICE_PROVIDER_IDS,
  resolveInvoiceCredentials,
  validateInvoiceHarvesterConfig,
};
