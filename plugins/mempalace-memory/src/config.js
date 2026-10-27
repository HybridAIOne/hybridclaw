import path from 'node:path';
import { resolvePluginPath } from '@hybridaione/hybridclaw/plugin-sdk';

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeValidatedInteger(value, key) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`mempalace-memory plugin config.${key} must be a number.`);
  }
  return Math.trunc(value);
}

export function resolveMempalacePluginConfig(pluginConfig, runtime) {
  const workingDirectory =
    resolvePluginPath(pluginConfig?.workingDirectory, runtime.cwd) ||
    runtime.cwd;
  return Object.freeze({
    command: normalizeString(pluginConfig?.command) || 'mempalace',
    workingDirectory,
    palacePath: resolvePluginPath(pluginConfig?.palacePath, runtime.cwd) || '',
    mcpServerName: normalizeString(pluginConfig?.mcpServerName) || 'mempalace',
    sessionExportDir:
      resolvePluginPath(pluginConfig?.sessionExportDir, runtime.cwd) ||
      path.resolve(runtime.cwd, '.hybridclaw', 'mempalace-turns'),
    wakeUpEnabled: pluginConfig?.wakeUpEnabled !== false,
    wakeUpWing: normalizeString(pluginConfig?.wakeUpWing),
    searchEnabled: pluginConfig?.searchEnabled !== false,
    searchWing: normalizeString(pluginConfig?.searchWing),
    searchRoom: normalizeString(pluginConfig?.searchRoom),
    updateWing: normalizeString(pluginConfig?.updateWing),
    updateAgent: normalizeString(pluginConfig?.updateAgent) || 'hybridclaw',
    saveEveryMessages: normalizeValidatedInteger(
      pluginConfig?.saveEveryMessages,
      'saveEveryMessages',
    ),
    maxResults: normalizeValidatedInteger(
      pluginConfig?.maxResults,
      'maxResults',
    ),
    maxWakeUpChars: normalizeValidatedInteger(
      pluginConfig?.maxWakeUpChars,
      'maxWakeUpChars',
    ),
    maxSearchChars: normalizeValidatedInteger(
      pluginConfig?.maxSearchChars,
      'maxSearchChars',
    ),
    maxInjectedChars: normalizeValidatedInteger(
      pluginConfig?.maxInjectedChars,
      'maxInjectedChars',
    ),
    timeoutMs: normalizeValidatedInteger(pluginConfig?.timeoutMs, 'timeoutMs'),
  });
}
