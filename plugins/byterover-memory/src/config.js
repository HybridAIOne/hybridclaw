import os from 'node:os';
import path from 'node:path';

const DEFAULT_MAX_INJECTED_CHARS = 4000;
const DEFAULT_QUERY_TIMEOUT_MS = 30_000;
const DEFAULT_CURATE_TIMEOUT_MS = 120_000;

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeInteger(value, fallback, key, bounds = {}) {
  const raw =
    typeof value === 'number' && Number.isFinite(value)
      ? Math.trunc(value)
      : fallback;
  if (!Number.isFinite(raw)) {
    throw new Error(`byterover-memory plugin config.${key} must be a number.`);
  }
  if (
    typeof bounds.minimum === 'number' &&
    Number.isFinite(bounds.minimum) &&
    raw < bounds.minimum
  ) {
    throw new Error(
      `byterover-memory plugin config.${key} must be >= ${bounds.minimum}.`,
    );
  }
  if (
    typeof bounds.maximum === 'number' &&
    Number.isFinite(bounds.maximum) &&
    raw > bounds.maximum
  ) {
    throw new Error(
      `byterover-memory plugin config.${key} must be <= ${bounds.maximum}.`,
    );
  }
  return raw;
}

function resolveRuntimePath(value, runtime) {
  const normalized = normalizeString(value);
  if (!normalized) return '';
  if (normalized === '~') return os.homedir();
  if (normalized.startsWith('~/')) {
    return path.join(os.homedir(), normalized.slice(2));
  }
  if (path.isAbsolute(normalized)) return normalized;
  return path.resolve(runtime.cwd, normalized);
}

function resolveDefaultWorkingDirectory(runtime) {
  const runtimeHome = normalizeString(runtime?.homeDir);
  if (runtimeHome) {
    return path.resolve(runtimeHome, 'byterover');
  }
  return path.resolve(os.homedir(), '.hybridclaw', 'byterover');
}

export function resolveByteRoverPluginConfig(pluginConfig, runtime) {
  return Object.freeze({
    command: normalizeString(pluginConfig?.command) || 'brv',
    workingDirectory:
      resolveRuntimePath(pluginConfig?.workingDirectory, runtime) ||
      resolveDefaultWorkingDirectory(runtime),
    autoCurate: pluginConfig?.autoCurate !== false,
    mirrorMemoryWrites: pluginConfig?.mirrorMemoryWrites !== false,
    maxInjectedChars: normalizeInteger(
      pluginConfig?.maxInjectedChars,
      DEFAULT_MAX_INJECTED_CHARS,
      'maxInjectedChars',
      { minimum: 500, maximum: 16_000 },
    ),
    queryTimeoutMs: normalizeInteger(
      pluginConfig?.queryTimeoutMs,
      DEFAULT_QUERY_TIMEOUT_MS,
      'queryTimeoutMs',
      { minimum: 1_000, maximum: 120_000 },
    ),
    curateTimeoutMs: normalizeInteger(
      pluginConfig?.curateTimeoutMs,
      DEFAULT_CURATE_TIMEOUT_MS,
      'curateTimeoutMs',
      { minimum: 1_000, maximum: 600_000 },
    ),
  });
}
