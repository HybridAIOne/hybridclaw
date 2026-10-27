import { resolvePluginPath } from '@hybridaione/hybridclaw/plugin-sdk';

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

export function resolveGbrainPluginConfig(pluginConfig, runtime) {
  const searchMode = normalizeString(pluginConfig?.searchMode).toLowerCase();
  const workingDirectory =
    resolvePluginPath(pluginConfig?.workingDirectory, runtime.cwd) ||
    runtime.cwd;

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
