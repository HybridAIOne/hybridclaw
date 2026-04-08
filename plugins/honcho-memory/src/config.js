import fs from 'node:fs';
import path from 'node:path';

const RECALL_MODES = new Set(['hybrid', 'context', 'tools']);
const SESSION_STRATEGIES = new Set([
  'platform',
  'per-directory',
  'per-repo',
  'per-session',
  'global',
]);
const REASONING_LEVELS = ['minimal', 'low', 'medium', 'high', 'max'];
const OBSERVATION_MODES = new Set(['directional', 'unified']);
const INJECTION_FREQUENCIES = new Set(['every-turn', 'first-turn']);

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

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
  if (!normalized) return 'async';
  if (
    normalized === 'async' ||
    normalized === 'turn' ||
    normalized === 'session'
  ) {
    return normalized;
  }
  throw new Error(
    'honcho-memory plugin config.writeFrequency must be a positive integer or one of: async, turn, session.',
  );
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
    'directional',
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
  const processEnvApiKey = normalizeString(params?.processEnvApiKey);
  const {
    observationMode,
    userObserveMe,
    userObserveOthers,
    agentObserveMe,
    agentObserveOthers,
  } = normalizeObservationConfig(pluginConfig);
  const saveMessages =
    typeof pluginConfig?.saveMessages === 'boolean'
      ? pluginConfig.saveMessages
      : normalizeBoolean(pluginConfig?.autoSync, true);

  return {
    baseUrl: normalizeString(pluginConfig?.baseUrl) || 'https://api.honcho.dev',
    apiKey:
      normalizeString(pluginConfig?.apiKey) ||
      credentialApiKey ||
      processEnvApiKey,
    workspaceId:
      normalizeString(pluginConfig?.workspaceId) ||
      defaultWorkspaceId(runtime.cwd),
    peerName: normalizeString(pluginConfig?.peerName),
    aiPeer: normalizeString(pluginConfig?.aiPeer),
    contextTokens: normalizeInteger(
      pluginConfig?.contextTokens,
      4000,
      'contextTokens',
      { minimum: 500, maximum: 20000 },
    ),
    searchLimit: normalizeInteger(pluginConfig?.searchLimit, 5, 'searchLimit', {
      minimum: 1,
      maximum: 50,
    }),
    maxInjectedChars: normalizeInteger(
      pluginConfig?.maxInjectedChars,
      5000,
      'maxInjectedChars',
      { minimum: 500, maximum: 50000 },
    ),
    includeSummary: normalizeBoolean(pluginConfig?.includeSummary, true),
    includeRecentMessages: normalizeBoolean(
      pluginConfig?.includeRecentMessages,
      true,
    ),
    includePeerRepresentation: normalizeBoolean(
      pluginConfig?.includePeerRepresentation,
      true,
    ),
    includePeerCard: normalizeBoolean(pluginConfig?.includePeerCard, true),
    includeAiPeerRepresentation: normalizeBoolean(
      pluginConfig?.includeAiPeerRepresentation,
      true,
    ),
    includeAiPeerCard: normalizeBoolean(pluginConfig?.includeAiPeerCard, false),
    limitToSession: normalizeBoolean(pluginConfig?.limitToSession, true),
    timeoutMs: normalizeInteger(pluginConfig?.timeoutMs, 15000, 'timeoutMs', {
      minimum: 1000,
      maximum: 60000,
    }),
    recallMode: normalizeEnum(
      pluginConfig?.recallMode,
      RECALL_MODES,
      'hybrid',
      'recallMode',
    ),
    writeFrequency: normalizeWriteFrequency(pluginConfig?.writeFrequency),
    saveMessages,
    sessionStrategy: normalizeEnum(
      pluginConfig?.sessionStrategy,
      SESSION_STRATEGIES,
      'platform',
      'sessionStrategy',
    ),
    sessionPeerPrefix: normalizeBoolean(pluginConfig?.sessionPeerPrefix, false),
    sessions: normalizeSessionsMap(pluginConfig?.sessions),
    dialecticReasoningLevel: normalizeReasoningLevel(
      pluginConfig?.dialecticReasoningLevel,
      'low',
      'dialecticReasoningLevel',
    ),
    dialecticDynamic: normalizeBoolean(pluginConfig?.dialecticDynamic, true),
    dialecticMaxChars: normalizeInteger(
      pluginConfig?.dialecticMaxChars,
      600,
      'dialecticMaxChars',
      { minimum: 100, maximum: 10000 },
    ),
    dialecticMaxInputChars: normalizeInteger(
      pluginConfig?.dialecticMaxInputChars,
      10000,
      'dialecticMaxInputChars',
      { minimum: 100, maximum: 50000 },
    ),
    messageMaxChars: normalizeInteger(
      pluginConfig?.messageMaxChars,
      25000,
      'messageMaxChars',
      { minimum: 100, maximum: 50000 },
    ),
    injectionFrequency: normalizeEnum(
      pluginConfig?.injectionFrequency,
      INJECTION_FREQUENCIES,
      'every-turn',
      'injectionFrequency',
    ),
    contextCadence: normalizeInteger(
      pluginConfig?.contextCadence,
      1,
      'contextCadence',
      { minimum: 1, maximum: 1000 },
    ),
    dialecticCadence: normalizeInteger(
      pluginConfig?.dialecticCadence,
      1,
      'dialecticCadence',
      { minimum: 1, maximum: 1000 },
    ),
    reasoningLevelCap: normalizeReasoningLevel(
      pluginConfig?.reasoningLevelCap,
      '',
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
