import path from 'node:path';
import {
  readString,
  resolvePluginPath,
} from '@hybridaione/hybridclaw/plugin-sdk';

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
    command: readString(pluginConfig?.command) || 'mempalace',
    workingDirectory,
    palacePath: resolvePluginPath(pluginConfig?.palacePath, runtime.cwd) || '',
    mcpServerName: readString(pluginConfig?.mcpServerName) || 'mempalace',
    sessionExportDir:
      resolvePluginPath(pluginConfig?.sessionExportDir, runtime.cwd) ||
      path.resolve(runtime.cwd, '.hybridclaw', 'mempalace-turns'),
    wakeUpEnabled: pluginConfig?.wakeUpEnabled !== false,
    wakeUpWing: readString(pluginConfig?.wakeUpWing),
    searchEnabled: pluginConfig?.searchEnabled !== false,
    searchWing: readString(pluginConfig?.searchWing),
    searchRoom: readString(pluginConfig?.searchRoom),
    updateWing: readString(pluginConfig?.updateWing),
    updateAgent: readString(pluginConfig?.updateAgent) || 'hybridclaw',
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
