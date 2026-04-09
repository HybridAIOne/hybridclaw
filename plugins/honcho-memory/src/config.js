import fs from 'node:fs';
import path from 'node:path';
import {
  HONCHO_CONFIG_BOOLEAN_DEFAULTS,
  HONCHO_CONFIG_NUMBER_FIELDS,
  HONCHO_CONFIG_STRING_DEFAULTS,
  HONCHO_INJECTION_FREQUENCIES,
  HONCHO_OBSERVATION_MODES,
  HONCHO_REASONING_LEVELS,
  HONCHO_RECALL_MODES,
  HONCHO_SESSION_STRATEGIES,
  HONCHO_WRITE_FREQUENCY_DEFAULT,
  HONCHO_WRITE_FREQUENCY_MODES,
} from './config-schema.js';
import { normalizeString } from './utils.js';

const RECALL_MODES = new Set(HONCHO_RECALL_MODES);
const SESSION_STRATEGIES = new Set(HONCHO_SESSION_STRATEGIES);
const REASONING_LEVELS = [...HONCHO_REASONING_LEVELS];
const OBSERVATION_MODES = new Set(HONCHO_OBSERVATION_MODES);
const INJECTION_FREQUENCIES = new Set(HONCHO_INJECTION_FREQUENCIES);

function normalizeInteger(value, fallback, key, bounds = {}) {
  const raw =
    typeof value === 'number' && Number.isFinite(value)
      ? Math.trunc(value)
      : null;
  const nextValue = raw ?? fallback;
  if (!Number.isFinite(nextValue)) {
    throw new Error(`honcho-memory plugin config.${key} must be a number.`);
  }
  if (
    typeof bounds.minimum === 'number' &&
    Number.isFinite(bounds.minimum) &&
    nextValue < bounds.minimum
  ) {
    throw new Error(
      `honcho-memory plugin config.${key} must be >= ${bounds.minimum}.`,
    );
  }
  if (
    typeof bounds.maximum === 'number' &&
    Number.isFinite(bounds.maximum) &&
    nextValue > bounds.maximum
  ) {
    throw new Error(
      `honcho-memory plugin config.${key} must be <= ${bounds.maximum}.`,
    );
  }
  return nextValue;
}

function normalizeBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeEnum(value, allowed, fallback, key) {
  const normalized = normalizeString(value).toLowerCase();
  if (!normalized) return fallback;
  if (!allowed.has(normalized)) {
    throw new Error(
      `honcho-memory plugin config.${key} must be one of: ${[...allowed].join(', ')}.`,
    );
  }
  return normalized;
}

function normalizeReasoningLevel(value, fallback, key) {
  const normalized = normalizeString(value).toLowerCase();
  if (!normalized) return fallback;
  if (!REASONING_LEVELS.includes(normalized)) {
    throw new Error(
      `honcho-memory plugin config.${key} must be one of: ${REASONING_LEVELS.join(', ')}.`,
    );
  }
  return normalized;
}

function normalizeWriteFrequency(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const nextValue = Math.trunc(value);
    if (nextValue <= 0) {
      throw new Error(
        'honcho-memory plugin config.writeFrequency must be a positive integer or one of: async, turn, session.',
      );
    }
    return nextValue;
  }
  const normalized = normalizeString(value).toLowerCase();
  if (!normalized) return HONCHO_WRITE_FREQUENCY_DEFAULT;
  if (HONCHO_WRITE_FREQUENCY_MODES.includes(normalized)) {
    return normalized;
  }
  throw new Error(
    'honcho-memory plugin config.writeFrequency must be a positive integer or one of: async, turn, session.',
  );
}

function normalizeBaseUrl(value) {
  const normalized =
    normalizeString(value) || HONCHO_CONFIG_STRING_DEFAULTS.baseUrl;
  try {
    new URL(normalized);
  } catch {
    throw new Error(
      'honcho-memory plugin config.baseUrl must be a valid absolute URL.',
    );
  }
  return normalized;
}

function defaultWorkspaceId(cwd) {
  const base = path.basename(String(cwd || '').trim()) || 'hybridclaw';
  const normalized = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'hybridclaw';
}

function normalizeSessionsMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = normalizeString(rawKey);
    const mapped = normalizeString(rawValue);
    if (!key || !mapped) continue;
    result[key] = mapped;
  }
  return result;
}

function resolveObservationPreset(mode) {
  if (mode === 'unified') {
    return {
      userObserveMe: true,
      userObserveOthers: false,
      agentObserveMe: false,
      agentObserveOthers: true,
    };
  }
  return {
    userObserveMe: true,
    userObserveOthers: true,
    agentObserveMe: true,
    agentObserveOthers: true,
  };
}

function normalizeObservationConfig(pluginConfig) {
  const observationMode = normalizeEnum(
    pluginConfig?.observationMode,
    OBSERVATION_MODES,
    HONCHO_CONFIG_STRING_DEFAULTS.observationMode,
    'observationMode',
  );
  const preset = resolveObservationPreset(observationMode);
  const observation =
    pluginConfig?.observation &&
    typeof pluginConfig.observation === 'object' &&
    !Array.isArray(pluginConfig.observation)
      ? pluginConfig.observation
      : null;
  const userBlock =
    observation?.user &&
    typeof observation.user === 'object' &&
    !Array.isArray(observation.user)
      ? observation.user
      : null;
  const agentBlock =
    observation?.ai &&
    typeof observation.ai === 'object' &&
    !Array.isArray(observation.ai)
      ? observation.ai
      : null;
  return {
    observationMode,
    userObserveMe: normalizeBoolean(userBlock?.observeMe, preset.userObserveMe),
    userObserveOthers: normalizeBoolean(
      userBlock?.observeOthers,
      preset.userObserveOthers,
    ),
    agentObserveMe: normalizeBoolean(
      agentBlock?.observeMe,
      preset.agentObserveMe,
    ),
    agentObserveOthers: normalizeBoolean(
      agentBlock?.observeOthers,
      preset.agentObserveOthers,
    ),
  };
}

export function resolveHonchoPluginConfig(params) {
  const pluginConfig = params?.pluginConfig || {};
  const runtime = params?.runtime || {};
  const credentialApiKey = normalizeString(params?.credentialApiKey);
  const {
    observationMode,
    userObserveMe,
    userObserveOthers,
    agentObserveMe,
    agentObserveOthers,
  } = normalizeObservationConfig(pluginConfig);
  const saveMessages = normalizeBoolean(
    pluginConfig?.saveMessages,
    HONCHO_CONFIG_BOOLEAN_DEFAULTS.saveMessages,
  );

  return {
    baseUrl: normalizeBaseUrl(pluginConfig?.baseUrl),
    apiKey: credentialApiKey,
    workspaceId:
      normalizeString(pluginConfig?.workspaceId) ||
      defaultWorkspaceId(runtime.cwd),
    peerName:
      normalizeString(pluginConfig?.peerName) ||
      HONCHO_CONFIG_STRING_DEFAULTS.peerName,
    aiPeer:
      normalizeString(pluginConfig?.aiPeer) ||
      HONCHO_CONFIG_STRING_DEFAULTS.aiPeer,
    contextTokens: normalizeInteger(
      pluginConfig?.contextTokens,
      HONCHO_CONFIG_NUMBER_FIELDS.contextTokens.default,
      'contextTokens',
      HONCHO_CONFIG_NUMBER_FIELDS.contextTokens,
    ),
    searchLimit: normalizeInteger(
      pluginConfig?.searchLimit,
      HONCHO_CONFIG_NUMBER_FIELDS.searchLimit.default,
      'searchLimit',
      HONCHO_CONFIG_NUMBER_FIELDS.searchLimit,
    ),
    maxInjectedChars: normalizeInteger(
      pluginConfig?.maxInjectedChars,
      HONCHO_CONFIG_NUMBER_FIELDS.maxInjectedChars.default,
      'maxInjectedChars',
      HONCHO_CONFIG_NUMBER_FIELDS.maxInjectedChars,
    ),
    includeSummary: normalizeBoolean(
      pluginConfig?.includeSummary,
      HONCHO_CONFIG_BOOLEAN_DEFAULTS.includeSummary,
    ),
    includeRecentMessages: normalizeBoolean(
      pluginConfig?.includeRecentMessages,
      HONCHO_CONFIG_BOOLEAN_DEFAULTS.includeRecentMessages,
    ),
    includePeerRepresentation: normalizeBoolean(
      pluginConfig?.includePeerRepresentation,
      HONCHO_CONFIG_BOOLEAN_DEFAULTS.includePeerRepresentation,
    ),
    includePeerCard: normalizeBoolean(
      pluginConfig?.includePeerCard,
      HONCHO_CONFIG_BOOLEAN_DEFAULTS.includePeerCard,
    ),
    includeAiPeerRepresentation: normalizeBoolean(
      pluginConfig?.includeAiPeerRepresentation,
      HONCHO_CONFIG_BOOLEAN_DEFAULTS.includeAiPeerRepresentation,
    ),
    includeAiPeerCard: normalizeBoolean(
      pluginConfig?.includeAiPeerCard,
      HONCHO_CONFIG_BOOLEAN_DEFAULTS.includeAiPeerCard,
    ),
    limitToSession: normalizeBoolean(
      pluginConfig?.limitToSession,
      HONCHO_CONFIG_BOOLEAN_DEFAULTS.limitToSession,
    ),
    timeoutMs: normalizeInteger(
      pluginConfig?.timeoutMs,
      HONCHO_CONFIG_NUMBER_FIELDS.timeoutMs.default,
      'timeoutMs',
      HONCHO_CONFIG_NUMBER_FIELDS.timeoutMs,
    ),
    recallMode: normalizeEnum(
      pluginConfig?.recallMode,
      RECALL_MODES,
      HONCHO_CONFIG_STRING_DEFAULTS.recallMode,
      'recallMode',
    ),
    writeFrequency: normalizeWriteFrequency(pluginConfig?.writeFrequency),
    saveMessages,
    sessionStrategy: normalizeEnum(
      pluginConfig?.sessionStrategy,
      SESSION_STRATEGIES,
      HONCHO_CONFIG_STRING_DEFAULTS.sessionStrategy,
      'sessionStrategy',
    ),
    sessionPeerPrefix: normalizeBoolean(
      pluginConfig?.sessionPeerPrefix,
      HONCHO_CONFIG_BOOLEAN_DEFAULTS.sessionPeerPrefix,
    ),
    sessions: normalizeSessionsMap(pluginConfig?.sessions),
    dialecticReasoningLevel: normalizeReasoningLevel(
      pluginConfig?.dialecticReasoningLevel,
      HONCHO_CONFIG_STRING_DEFAULTS.dialecticReasoningLevel,
      'dialecticReasoningLevel',
    ),
    dialecticDynamic: normalizeBoolean(
      pluginConfig?.dialecticDynamic,
      HONCHO_CONFIG_BOOLEAN_DEFAULTS.dialecticDynamic,
    ),
    dialecticMaxChars: normalizeInteger(
      pluginConfig?.dialecticMaxChars,
      HONCHO_CONFIG_NUMBER_FIELDS.dialecticMaxChars.default,
      'dialecticMaxChars',
      HONCHO_CONFIG_NUMBER_FIELDS.dialecticMaxChars,
    ),
    dialecticMaxInputChars: normalizeInteger(
      pluginConfig?.dialecticMaxInputChars,
      HONCHO_CONFIG_NUMBER_FIELDS.dialecticMaxInputChars.default,
      'dialecticMaxInputChars',
      HONCHO_CONFIG_NUMBER_FIELDS.dialecticMaxInputChars,
    ),
    messageMaxChars: normalizeInteger(
      pluginConfig?.messageMaxChars,
      HONCHO_CONFIG_NUMBER_FIELDS.messageMaxChars.default,
      'messageMaxChars',
      HONCHO_CONFIG_NUMBER_FIELDS.messageMaxChars,
    ),
    injectionFrequency: normalizeEnum(
      pluginConfig?.injectionFrequency,
      INJECTION_FREQUENCIES,
      HONCHO_CONFIG_STRING_DEFAULTS.injectionFrequency,
      'injectionFrequency',
    ),
    contextCadence: normalizeInteger(
      pluginConfig?.contextCadence,
      HONCHO_CONFIG_NUMBER_FIELDS.contextCadence.default,
      'contextCadence',
      HONCHO_CONFIG_NUMBER_FIELDS.contextCadence,
    ),
    dialecticCadence: normalizeInteger(
      pluginConfig?.dialecticCadence,
      HONCHO_CONFIG_NUMBER_FIELDS.dialecticCadence.default,
      'dialecticCadence',
      HONCHO_CONFIG_NUMBER_FIELDS.dialecticCadence,
    ),
    reasoningLevelCap: normalizeReasoningLevel(
      pluginConfig?.reasoningLevelCap,
      HONCHO_CONFIG_STRING_DEFAULTS.reasoningLevelCap,
      'reasoningLevelCap',
    ),
    observationMode,
    userObserveMe,
    userObserveOthers,
    agentObserveMe,
    agentObserveOthers,
  };
}

export function resolveHonchoSessionKey(params) {
  const config = params.config;
  const runtimeCwd = normalizeString(params.cwd);
  const currentPath = runtimeCwd || process.cwd();
  const manualSession = config.sessions[currentPath];
  if (manualSession) {
    return applySessionPeerPrefix(config, manualSession);
  }

  if (config.sessionStrategy === 'global') {
    return applySessionPeerPrefix(config, config.workspaceId);
  }

  if (config.sessionStrategy === 'per-session') {
    const platformSessionId = normalizeString(params.platformSessionId);
    if (platformSessionId) {
      return applySessionPeerPrefix(config, platformSessionId);
    }
  }

  if (config.sessionStrategy === 'per-repo') {
    const repoName = findGitRepoName(currentPath);
    if (repoName) {
      return applySessionPeerPrefix(config, repoName);
    }
  }

  if (config.sessionStrategy === 'per-directory') {
    return applySessionPeerPrefix(
      config,
      path.basename(currentPath) || 'workspace',
    );
  }

  const platformSessionId = normalizeString(params.platformSessionId);
  return applySessionPeerPrefix(config, platformSessionId || 'session');
}

function applySessionPeerPrefix(config, sessionKey) {
  const normalized = normalizeString(sessionKey);
  if (!normalized) return 'session';
  if (!config.sessionPeerPrefix) return normalized;
  const prefix =
    normalizeString(config.peerName) || normalizeString(config.aiPeer) || '';
  if (!prefix) return normalized;
  return `${prefix}-${normalized}`;
}

function findGitRepoName(cwd) {
  let current = path.resolve(String(cwd || '.'));
  while (true) {
    if (path.basename(current) === '.git') {
      return path.basename(path.dirname(current));
    }
    const gitPath = path.join(current, '.git');
    if (gitPath && isGitEntry(gitPath)) {
      return path.basename(current);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return '';
}

function isGitEntry(candidate) {
  try {
    return fs.existsSync(candidate);
  } catch {
    return false;
  }
}

export function normalizeHonchoSessionConfigForWrite(config) {
  return {
    ...config,
    sessions: { ...(config.sessions || {}) },
  };
}

export function dynamicReasoningLevel(config, query, floorOverride) {
  const levels = REASONING_LEVELS;
  const floor = normalizeReasoningLevel(
    floorOverride,
    config.dialecticReasoningLevel,
    'dialecticReasoningLevel',
  );
  if (!config.dialecticDynamic) {
    return capReasoningLevel(floor, config.reasoningLevelCap);
  }
  const defaultIndex = Math.max(0, levels.indexOf(floor));
  const queryLength = String(query || '').trim().length;
  const bump = queryLength < 120 ? 0 : queryLength < 400 ? 1 : 2;
  const automaticLevel = levels[Math.min(defaultIndex + bump, 3)] || floor;
  return capReasoningLevel(automaticLevel, config.reasoningLevelCap);
}

function capReasoningLevel(level, cap) {
  const normalizedCap = normalizeString(cap).toLowerCase();
  if (!normalizedCap) return level;
  const levelIndex = REASONING_LEVELS.indexOf(level);
  const capIndex = REASONING_LEVELS.indexOf(normalizedCap);
  if (levelIndex === -1 || capIndex === -1) return level;
  return REASONING_LEVELS[Math.min(levelIndex, capIndex)] || level;
}
