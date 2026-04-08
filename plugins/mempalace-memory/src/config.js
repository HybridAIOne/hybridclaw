import path from 'node:path';

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeValidatedInteger(value, key) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`mempalace-memory plugin config.${key} must be a number.`);
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

export function resolveMempalacePluginConfig(pluginConfig, runtime) {
  const workingDirectory =
    resolveRuntimePath(pluginConfig?.workingDirectory, runtime) || runtime.cwd;
  return Object.freeze({
    command: normalizeString(pluginConfig?.command) || 'mempalace',
    workingDirectory,
    palacePath: resolveRuntimePath(pluginConfig?.palacePath, runtime) || '',
    wakeUpEnabled: pluginConfig?.wakeUpEnabled !== false,
    wakeUpWing: normalizeString(pluginConfig?.wakeUpWing),
    searchEnabled: pluginConfig?.searchEnabled !== false,
    searchWing: normalizeString(pluginConfig?.searchWing),
    searchRoom: normalizeString(pluginConfig?.searchRoom),
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
