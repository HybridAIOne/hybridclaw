import path from 'node:path';

const DEFAULT_SEARCH_MODE = 'search';
const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_MAX_SNIPPET_CHARS = 600;
const DEFAULT_MAX_INJECTED_CHARS = 4000;
const DEFAULT_TIMEOUT_MS = 12_000;

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clampInteger(value, fallback, min, max) {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(numeric)) return fallback;
  const truncated = Math.trunc(numeric);
  return Math.max(min, Math.min(max, truncated));
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
    maxResults: clampInteger(
      pluginConfig?.maxResults,
      DEFAULT_MAX_RESULTS,
      1,
      20,
    ),
    maxSnippetChars: clampInteger(
      pluginConfig?.maxSnippetChars,
      DEFAULT_MAX_SNIPPET_CHARS,
      100,
      2000,
    ),
    maxInjectedChars: clampInteger(
      pluginConfig?.maxInjectedChars,
      DEFAULT_MAX_INJECTED_CHARS,
      500,
      16_000,
    ),
    timeoutMs: clampInteger(
      pluginConfig?.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      1000,
      60_000,
    ),
    sessionExport: pluginConfig?.sessionExport === true,
    sessionExportDir:
      resolveRuntimePath(pluginConfig?.sessionExportDir, runtime) ||
      path.join(workingDirectory, '.hybridclaw', 'qmd-sessions'),
  });
}
