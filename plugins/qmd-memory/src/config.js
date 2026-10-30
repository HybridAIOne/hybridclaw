import path from 'node:path';
import {
  readString,
  resolvePluginPath,
} from '@hybridaione/hybridclaw/plugin-sdk';

const DEFAULT_SEARCH_MODE = 'query';

function normalizeValidatedInteger(value, key) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`qmd-memory plugin config.${key} must be a number.`);
  }
  return Math.trunc(value);
}

export function resolveQmdPluginConfig(pluginConfig, runtime) {
  const searchMode = readString(pluginConfig?.searchMode).toLowerCase();
  const workingDirectory =
    resolvePluginPath(pluginConfig?.workingDirectory, runtime.cwd) ||
    runtime.cwd;
  return Object.freeze({
    command: readString(pluginConfig?.command) || 'qmd',
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
      resolvePluginPath(pluginConfig?.sessionExportDir, runtime.cwd) ||
      path.join(workingDirectory, '.hybridclaw', 'qmd-sessions'),
  });
}
