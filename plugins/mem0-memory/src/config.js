const MEM0_API_VERSIONS = new Set(['v1', 'v2']);

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeInteger(value, key, fallback, bounds = {}) {
  if (value == null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`mem0-memory plugin config.${key} must be a number.`);
  }
  const normalized = Math.trunc(value);
  if (
    typeof bounds.minimum === 'number' &&
    normalized < Math.trunc(bounds.minimum)
  ) {
    throw new Error(
      `mem0-memory plugin config.${key} must be >= ${Math.trunc(bounds.minimum)}.`,
    );
  }
  if (
    typeof bounds.maximum === 'number' &&
    normalized > Math.trunc(bounds.maximum)
  ) {
    throw new Error(
      `mem0-memory plugin config.${key} must be <= ${Math.trunc(bounds.maximum)}.`,
    );
  }
  return normalized;
}

function normalizeApiVersion(value) {
  const normalized = normalizeString(value) || 'v2';
  if (!MEM0_API_VERSIONS.has(normalized)) {
    throw new Error(
      `mem0-memory plugin config.apiVersion must be one of: ${[...MEM0_API_VERSIONS].join(', ')}.`,
    );
  }
  return normalized;
}

function normalizeAbsoluteUrl(value, key, fallback) {
  const normalized = normalizeString(value) || fallback;
  try {
    const url = new URL(normalized);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('unsupported');
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    throw new Error(
      `mem0-memory plugin config.${key} must be a valid absolute URL.`,
    );
  }
}

export function resolveMem0PluginConfig(params) {
  const pluginConfig = params?.pluginConfig || {};
  return Object.freeze({
    apiKey: normalizeString(params?.credentialApiKey),
    host: normalizeAbsoluteUrl(
      pluginConfig.host,
      'host',
      'https://api.mem0.ai',
    ),
    organizationId: normalizeString(pluginConfig.organizationId),
    projectId: normalizeString(pluginConfig.projectId),
    userId: normalizeString(pluginConfig.userId),
    agentId: normalizeString(pluginConfig.agentId),
    apiVersion: normalizeApiVersion(pluginConfig.apiVersion),
    searchLimit: normalizeInteger(pluginConfig.searchLimit, 'searchLimit', 5, {
      minimum: 1,
      maximum: 20,
    }),
    profileLimit: normalizeInteger(
      pluginConfig.profileLimit,
      'profileLimit',
      10,
      {
        minimum: 1,
        maximum: 50,
      },
    ),
    maxInjectedChars: normalizeInteger(
      pluginConfig.maxInjectedChars,
      'maxInjectedChars',
      4000,
      {
        minimum: 500,
        maximum: 20000,
      },
    ),
    messageMaxChars: normalizeInteger(
      pluginConfig.messageMaxChars,
      'messageMaxChars',
      4000,
      {
        minimum: 200,
        maximum: 20000,
      },
    ),
    timeoutMs: normalizeInteger(pluginConfig.timeoutMs, 'timeoutMs', 15000, {
      minimum: 1000,
      maximum: 60000,
    }),
    prefetchRerank: pluginConfig.prefetchRerank !== false,
    includeProfile: pluginConfig.includeProfile !== false,
    includeSearch: pluginConfig.includeSearch !== false,
    readAgentScope: pluginConfig.readAgentScope === true,
    syncTurns: pluginConfig.syncTurns !== false,
    mirrorNativeMemoryWrites: pluginConfig.mirrorNativeMemoryWrites !== false,
    prefetchOnSessionStart: pluginConfig.prefetchOnSessionStart !== false,
    syncCompaction: pluginConfig.syncCompaction !== false,
  });
}
