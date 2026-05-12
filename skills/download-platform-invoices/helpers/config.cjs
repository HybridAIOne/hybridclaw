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

const INVOICE_QUARANTINE_ISSUE = '#778';

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
    const secret = resolveSecretInput(providerId, key, value, opts);
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

function resolveSecretInput(providerId, key, value, opts = {}) {
  const id = secretId(value);
  if (!id) return null;
  if (isStoreSecretRef(value)) {
    const secret = readCredentialStore(opts.credentialStore, id);
    if (!secret) {
      throw new Error(
        `Missing ${providerId} invoice credential ${key}: credential store secret ${id} is not set.`,
      );
    }
    return secret;
  }
  const secret = process.env[id];
  if (!secret) {
    throw new Error(
      `Missing ${providerId} invoice credential ${key}: environment secret ${id} is not set.`,
    );
  }
  return secret;
}

async function rotateInvoiceCredentials(providerId, inputs, opts = {}) {
  const refs = rotatableCredentialRefs(inputs);
  if (refs.length === 0) return null;
  if (!opts.credentialStore || typeof opts.credentialStore.rotate !== 'function') {
    throw new Error(
      `Cannot rotate ${providerId} invoice credentials: credentialStore.rotate is not configured.`,
    );
  }
  const rotated = {};
  const rotations = [];
  for (const ref of refs) {
    const result = await opts.credentialStore.rotate(ref.id, {
      providerId,
      key: ref.key,
      reason: opts.reason || 'invoice_auth_failed',
    });
    const secret = normalizeCredentialStoreResult(result);
    if (!secret) {
      throw new Error(
        `Credential store did not return a rotated ${providerId} invoice credential ${ref.key}.`,
      );
    }
    rotated[ref.key] = secret;
    rotations.push({ key: ref.key, id: ref.id, revision: result?.revision || null });
    opts.audit?.(
      { source: 'store', id: ref.id, revision: result?.revision || null },
      `rotate ${providerId} invoice credential ${ref.key}`,
    );
  }
  return { credentials: rotated, rotations };
}

async function rollbackInvoiceCredentialRotations(providerId, rotations, opts = {}) {
  if (!rotations || rotations.length === 0) return;
  if (!opts.credentialStore || typeof opts.credentialStore.rollback !== 'function') {
    throw new Error(
      `Cannot rollback ${providerId} invoice credentials: credentialStore.rollback is not configured.`,
    );
  }
  for (const rotation of rotations) {
    await opts.credentialStore.rollback(rotation.id, {
      providerId,
      key: rotation.key,
      revision: rotation.revision,
      reason: opts.reason || 'invoice_rotation_retry_failed',
    });
    opts.audit?.(
      { source: 'store', id: rotation.id, revision: rotation.revision || null },
      `rollback ${providerId} invoice credential ${rotation.key}`,
    );
  }
}

function hasRotatableInvoiceCredentials(inputs) {
  return rotatableCredentialRefs(inputs).length > 0;
}

function rotatableCredentialRefs(inputs) {
  return Object.entries(inputs || {})
    .filter(([, value]) => isStoreSecretRef(value))
    .map(([key, value]) => ({ key, id: value.id }));
}

function isStoreSecretRef(value) {
  return Boolean(value && typeof value === 'object' && value.source === 'store');
}

function readCredentialStore(store, id) {
  if (!store) return process.env[id] || null;
  if (typeof store.get === 'function') return normalizeCredentialStoreResult(store.get(id));
  if (typeof store.read === 'function') return normalizeCredentialStoreResult(store.read(id));
  if (typeof store.resolve === 'function') return normalizeCredentialStoreResult(store.resolve(id));
  throw new Error('Credential store must expose get(id), read(id), or resolve(id).');
}

function normalizeCredentialStoreResult(result) {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object' && typeof result.value === 'string') {
    return result.value;
  }
  if (result && typeof result === 'object' && typeof result.secret === 'string') {
    return result.secret;
  }
  return null;
}

function parseUnverifiedSelectorAllowList(value = process.env.INVOICE_UNVERIFIED_SELECTORS) {
  if (!value) return { all: false, providers: new Set() };
  const tokens = String(value)
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return {
    all: tokens.includes('1') || tokens.includes('all') || tokens.includes('*'),
    providers: new Set(tokens),
  };
}

function isUnverifiedSelectorAllowed(providerId, value) {
  const allowList = parseUnverifiedSelectorAllowList(value);
  const normalized = String(providerId || '').toLowerCase();
  return allowList.all || allowList.providers.has(normalized);
}

function createInvoiceQuarantineError(providerId) {
  const error = new Error(
    `Invoice adapter ${providerId} uses unverified selectors and is quarantined until ${INVOICE_QUARANTINE_ISSUE}. Set INVOICE_UNVERIFIED_SELECTORS=${providerId} or INVOICE_UNVERIFIED_SELECTORS=all to run it explicitly.`,
  );
  error.code = 'INVOICE_QUARANTINED';
  error.providerId = providerId;
  return error;
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
  createInvoiceQuarantineError,
  hasRotatableInvoiceCredentials,
  INVOICE_PROVIDER_IDS,
  INVOICE_QUARANTINE_ISSUE,
  isUnverifiedSelectorAllowed,
  parseUnverifiedSelectorAllowList,
  resolveInvoiceCredentials,
  rollbackInvoiceCredentialRotations,
  rotateInvoiceCredentials,
  validateInvoiceHarvesterConfig,
};
