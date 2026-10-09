import type {
  RuntimeConfig,
  RuntimePluginConfigEntry,
} from '../config/runtime-config.js';
import {
  getRuntimeConfig,
  runtimeConfigPath,
  saveRuntimeConfig,
} from '../config/runtime-config.js';
import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-paths.js';
import {
  assertPluginConfigKeyDeclared,
  validatePluginConfig,
} from './plugin-config-validation.js';
import {
  PluginManager,
  resolveEffectivePluginConfigSchema,
} from './plugin-manager.js';

export interface PluginConfigReadResult {
  pluginId: string;
  configPath: string;
  entry: RuntimePluginConfigEntry | null;
}

export interface PluginConfigValueReadResult extends PluginConfigReadResult {
  key: string;
  value: unknown;
}

export interface PluginConfigWriteResult extends PluginConfigValueReadResult {
  changed: boolean;
  removed: boolean;
}

export interface PluginEnabledWriteResult extends PluginConfigReadResult {
  enabled: boolean;
  changed: boolean;
}

interface PluginConfigRuntimeOverride {
  homeDir?: string;
  cwd?: string;
}

function cloneConfig(config: RuntimeConfig): RuntimeConfig {
  return structuredClone(config);
}

function normalizePluginId(pluginId: string): string {
  return String(pluginId || '').trim();
}

function findPluginEntry(
  config: RuntimeConfig,
  pluginId: string,
): RuntimePluginConfigEntry | null {
  const normalizedPluginId = normalizePluginId(pluginId);
  return (
    config.plugins.list.find(
      (entry) => String(entry.id || '').trim() === normalizedPluginId,
    ) || null
  );
}

function ensurePluginEntry(
  config: RuntimeConfig,
  pluginId: string,
): RuntimePluginConfigEntry {
  const normalizedPluginId = normalizePluginId(pluginId);
  const existing = findPluginEntry(config, normalizedPluginId);
  if (existing) {
    existing.config = existing.config || {};
    return existing;
  }
  const entry: RuntimePluginConfigEntry = {
    id: normalizedPluginId,
    enabled: true,
    config: {},
  };
  config.plugins.list.push(entry);
  return entry;
}

// A bare enabled entry is redundant for a plugin discovered from the runtime
// home, but it is the install itself for a bundled plugin enabled in place.
async function cleanupPluginEntry(
  config: RuntimeConfig,
  pluginId: string,
  entry: RuntimePluginConfigEntry,
  runtime?: PluginConfigRuntimeOverride,
): Promise<void> {
  const hasConfigKeys = Object.keys(entry.config || {}).length > 0;
  if (hasConfigKeys || entry.enabled === false || entry.path) return;
  const withoutEntry = cloneConfig(config);
  withoutEntry.plugins.list = withoutEntry.plugins.list.filter(
    (candidate) => candidate.id !== pluginId,
  );
  const manager = new PluginManager({
    homeDir: runtime?.homeDir || DEFAULT_RUNTIME_HOME_DIR,
    cwd: runtime?.cwd || process.cwd(),
    getRuntimeConfig: () => withoutEntry,
  });
  const stillDiscovered = (await manager.discoverPlugins(withoutEntry)).some(
    (candidate) => candidate.id === pluginId,
  );
  if (stillDiscovered) config.plugins.list = withoutEntry.plugins.list;
}

async function validatePluginOverride(
  pluginId: string,
  config: RuntimeConfig,
  runtime?: PluginConfigRuntimeOverride,
  writtenKey?: string,
): Promise<void> {
  const manager = new PluginManager({
    homeDir: runtime?.homeDir || DEFAULT_RUNTIME_HOME_DIR,
    cwd: runtime?.cwd || process.cwd(),
    getRuntimeConfig: () => config,
  });
  const candidate = (await manager.discoverPlugins(config)).find(
    (entry) => entry.id === pluginId,
  );
  if (!candidate) {
    throw new Error(
      `Plugin \`${pluginId}\` was not found. Install or discover it before changing config.`,
    );
  }
  const schema = await resolveEffectivePluginConfigSchema(candidate);
  if (writtenKey === undefined) {
    validatePluginConfig(schema, candidate.config);
    return;
  }
  assertPluginConfigKeyDeclared({
    pluginId,
    schema,
    config: candidate.config,
    key: writtenKey,
  });
}

async function ensurePluginExistsForConfig(
  pluginId: string,
  config: RuntimeConfig,
  runtime?: PluginConfigRuntimeOverride,
): Promise<void> {
  const manager = new PluginManager({
    homeDir: runtime?.homeDir || DEFAULT_RUNTIME_HOME_DIR,
    cwd: runtime?.cwd || process.cwd(),
    getRuntimeConfig: () => config,
  });
  const candidateConfig = cloneConfig(config);
  ensurePluginEntry(candidateConfig, pluginId).enabled = true;
  const candidate = (await manager.discoverPlugins(candidateConfig)).find(
    (entry) => entry.id === pluginId,
  );
  if (!candidate) {
    throw new Error(
      `Plugin \`${pluginId}\` was not found. Install or discover it before changing enabled state.`,
    );
  }
}

function readConfigValue(
  entry: RuntimePluginConfigEntry | null,
  key: string,
): unknown {
  if (!entry) return undefined;
  return entry.config?.[key];
}

export function parsePluginConfigValue(raw: string): unknown {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

export function readPluginConfigEntry(
  pluginId: string,
): PluginConfigReadResult {
  const normalizedPluginId = normalizePluginId(pluginId);
  const config = getRuntimeConfig();
  return {
    pluginId: normalizedPluginId,
    configPath: runtimeConfigPath(),
    entry: structuredClone(findPluginEntry(config, normalizedPluginId)),
  };
}

export function readPluginConfigValue(
  pluginId: string,
  key: string,
): PluginConfigValueReadResult {
  const normalizedPluginId = normalizePluginId(pluginId);
  const normalizedKey = String(key || '').trim();
  const config = getRuntimeConfig();
  const entry = findPluginEntry(config, normalizedPluginId);
  return {
    pluginId: normalizedPluginId,
    key: normalizedKey,
    value: readConfigValue(entry, normalizedKey),
    configPath: runtimeConfigPath(),
    entry: structuredClone(entry),
  };
}

export async function writePluginConfigValue(
  pluginId: string,
  key: string,
  rawValue: string,
  runtime?: PluginConfigRuntimeOverride,
): Promise<PluginConfigWriteResult> {
  const normalizedPluginId = normalizePluginId(pluginId);
  const normalizedKey = String(key || '').trim();
  const value = parsePluginConfigValue(rawValue);
  const nextConfig = cloneConfig(getRuntimeConfig());
  const entry = ensurePluginEntry(nextConfig, normalizedPluginId);
  const previousValue = entry.config?.[normalizedKey];
  entry.config[normalizedKey] = value;
  await validatePluginOverride(
    normalizedPluginId,
    nextConfig,
    runtime,
    normalizedKey,
  );
  saveRuntimeConfig(nextConfig);
  return {
    pluginId: normalizedPluginId,
    key: normalizedKey,
    value,
    changed: !Object.is(previousValue, value),
    removed: false,
    configPath: runtimeConfigPath(),
    entry: structuredClone(findPluginEntry(nextConfig, normalizedPluginId)),
  };
}

export async function unsetPluginConfigValue(
  pluginId: string,
  key: string,
  runtime?: PluginConfigRuntimeOverride,
): Promise<PluginConfigWriteResult> {
  const normalizedPluginId = normalizePluginId(pluginId);
  const normalizedKey = String(key || '').trim();
  const nextConfig = cloneConfig(getRuntimeConfig());
  const entry = ensurePluginEntry(nextConfig, normalizedPluginId);
  const previousValue = entry.config?.[normalizedKey];
  delete entry.config[normalizedKey];
  await cleanupPluginEntry(nextConfig, normalizedPluginId, entry, runtime);
  await validatePluginOverride(normalizedPluginId, nextConfig, runtime);
  saveRuntimeConfig(nextConfig);
  return {
    pluginId: normalizedPluginId,
    key: normalizedKey,
    value: undefined,
    changed: previousValue !== undefined,
    removed: true,
    configPath: runtimeConfigPath(),
    entry: structuredClone(findPluginEntry(nextConfig, normalizedPluginId)),
  };
}

export async function setPluginEnabled(
  pluginId: string,
  enabled: boolean,
): Promise<PluginEnabledWriteResult> {
  const normalizedPluginId = normalizePluginId(pluginId);
  const nextConfig = cloneConfig(getRuntimeConfig());
  const existing = findPluginEntry(nextConfig, normalizedPluginId);
  if (enabled && !existing) {
    return {
      pluginId: normalizedPluginId,
      enabled: true,
      changed: false,
      configPath: runtimeConfigPath(),
      entry: null,
    };
  }

  if (enabled) {
    await ensurePluginExistsForConfig(normalizedPluginId, nextConfig);
  }

  const previousEnabled = existing ? existing.enabled !== false : true;
  const entry = existing ?? ensurePluginEntry(nextConfig, normalizedPluginId);
  entry.enabled = enabled;
  await cleanupPluginEntry(nextConfig, normalizedPluginId, entry);
  if (enabled) {
    await validatePluginOverride(normalizedPluginId, nextConfig);
  }
  saveRuntimeConfig(nextConfig);
  return {
    pluginId: normalizedPluginId,
    enabled,
    changed: previousEnabled !== enabled,
    configPath: runtimeConfigPath(),
    entry: structuredClone(findPluginEntry(nextConfig, normalizedPluginId)),
  };
}
