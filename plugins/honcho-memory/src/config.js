import path from 'node:path';

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeValidatedInteger(value, key) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`honcho-memory plugin config.${key} must be a number.`);
  }
  return Math.trunc(value);
}

function defaultWorkspaceId(cwd) {
  const base = path.basename(String(cwd || '').trim()) || 'hybridclaw';
  const normalized = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'hybridclaw';
}

export function resolveHonchoPluginConfig(pluginConfig, runtime) {
  return Object.freeze({
    baseUrl: normalizeString(pluginConfig?.baseUrl) || 'https://api.honcho.dev',
    apiKey: normalizeString(pluginConfig?.apiKey),
    workspaceId:
      normalizeString(pluginConfig?.workspaceId) ||
      defaultWorkspaceId(runtime.cwd),
    contextTokens: normalizeValidatedInteger(
      pluginConfig?.contextTokens,
      'contextTokens',
    ),
    searchLimit: normalizeValidatedInteger(
      pluginConfig?.searchLimit,
      'searchLimit',
    ),
    maxInjectedChars: normalizeValidatedInteger(
      pluginConfig?.maxInjectedChars,
      'maxInjectedChars',
    ),
    includeSummary: pluginConfig?.includeSummary !== false,
    includeRecentMessages: pluginConfig?.includeRecentMessages !== false,
    includePeerRepresentation:
      pluginConfig?.includePeerRepresentation !== false,
    includePeerCard: pluginConfig?.includePeerCard !== false,
    limitToSession: pluginConfig?.limitToSession !== false,
    autoSync: pluginConfig?.autoSync !== false,
    timeoutMs: normalizeValidatedInteger(pluginConfig?.timeoutMs, 'timeoutMs'),
  });
}
