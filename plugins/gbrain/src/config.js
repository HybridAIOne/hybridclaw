import path from 'node:path';

const DEFAULT_SEARCH_MODE = 'query';

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeValidatedInteger(value, key) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`gbrain plugin config.${key} must be a number.`);
  }
  return Math.trunc(value);
}

function resolveRuntimePath(value, runtime) {
  const normalized = normalizeString(value);
  if (!normalized) return '';
  if (normalized === '~') return runtime.homeDir;
  if (normalized.startsWith('~/')) {
    return path.join(runtime.homeDir, normalized.slice(2));
  }
  if (path.isAbsolute(normalized)) return normalized;
  return path.resolve(runtime.cwd, normalized);
}

export function resolveGbrainPluginConfig(pluginConfig, runtime) {
  const searchMode = normalizeString(pluginConfig?.searchMode).toLowerCase();
  const workingDirectory =
    resolveRuntimePath(pluginConfig?.workingDirectory, runtime) || runtime.cwd;

  return Object.freeze({
    command: normalizeString(pluginConfig?.command) || 'gbrain',
    workingDirectory,
    searchMode: searchMode === 'search' ? 'search' : DEFAULT_SEARCH_MODE,
    maxResults: normalizeValidatedInteger(
      pluginConfig?.maxResults,
      'maxResults',
    ),
    maxSnippetChars: normalizeValidatedInteger(
      pluginConfig?.maxSnippetChars,
      'maxSnippetChars',
    ),
    maxInjectedChars: normalizeValidatedInteger(
      pluginConfig?.maxInjectedChars,
      'maxInjectedChars',
    ),
    timeoutMs: normalizeValidatedInteger(pluginConfig?.timeoutMs, 'timeoutMs'),
  });
}
