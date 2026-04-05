import path from 'node:path';

function toTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function toBoundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function resolveEvalPluginConfig(pluginConfig, runtime) {
  const dataDir =
    toTrimmedString(pluginConfig.dataDir) ||
    path.join(runtime.homeDir, '.hybridclaw', 'evals');
  return {
    dataDir,
    runsDir: path.join(dataDir, 'runs'),
    cacheDir: path.join(dataDir, 'cache'),
    mmluBaseUrl:
      toTrimmedString(pluginConfig.mmluBaseUrl) ||
      'https://raw.githubusercontent.com/hendrycks/test/master/data/test',
    defaultSamples: toBoundedInteger(pluginConfig.defaultSamples, 30, 1, 200),
    maxSamples: toBoundedInteger(pluginConfig.maxSamples, 200, 1, 500),
  };
}
