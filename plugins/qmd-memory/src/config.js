import path from 'node:path';

const DEFAULT_SEARCH_MODE = 'query';

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// The manifest schema owns defaults and bounds for numeric settings.
// This helper only normalizes already-validated numbers to integers.
function normalizeValidatedInteger(value, key) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`qmd-memory plugin config.${key} must be a number.`);
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

export function resolveQmdPluginConfig(pluginConfig, runtime) {
  const searchMode = normalizeString(pluginConfig?.searchMode).toLowerCase();
  const workingDirectory =
    resolveRuntimePath(pluginConfig?.workingDirectory, runtime) || runtime.cwd;
  return Object.freeze({
    command: normalizeString(pluginConfig?.command) || 'qmd',
    workingDirectory,
    searchMode:
      searchMode === 'vsearch' || searchMode === 'query'
        ? searchMode
        : DEFAULT_SEARCH_MODE,
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
    sessionExport: pluginConfig?.sessionExport === true,
    sessionExportDir:
      resolveRuntimePath(pluginConfig?.sessionExportDir, runtime) ||
      path.join(workingDirectory, '.hybridclaw', 'qmd-sessions'),
  });
}
