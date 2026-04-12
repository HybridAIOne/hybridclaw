export const HONCHO_RECALL_MODES = ['hybrid', 'context', 'tools'];
export const HONCHO_SESSION_STRATEGIES = [
  'platform',
  'per-directory',
  'per-repo',
  'per-session',
  'global',
];
export const HONCHO_REASONING_LEVELS = [
  'minimal',
  'low',
  'medium',
  'high',
  'max',
];
export const HONCHO_OBSERVATION_MODES = ['directional', 'unified'];
export const HONCHO_INJECTION_FREQUENCIES = ['every-turn', 'first-turn'];
export const HONCHO_WRITE_FREQUENCY_MODES = ['async', 'turn', 'session'];
export const HONCHO_WRITE_FREQUENCY_DEFAULT = 'async';

export const HONCHO_CONFIG_NUMBER_FIELDS = {
  contextTokens: { default: 4000, minimum: 500, maximum: 20000 },
  searchLimit: { default: 5, minimum: 1, maximum: 50 },
  maxInjectedChars: { default: 5000, minimum: 500, maximum: 50000 },
  messageMaxChars: { default: 25000, minimum: 100, maximum: 50000 },
  timeoutMs: { default: 15000, minimum: 1000, maximum: 60000 },
  dialecticMaxChars: { default: 600, minimum: 100, maximum: 10000 },
  dialecticMaxInputChars: { default: 10000, minimum: 100, maximum: 50000 },
  contextCadence: { default: 1, minimum: 1, maximum: 1000 },
  dialecticCadence: { default: 1, minimum: 1, maximum: 1000 },
};

export const HONCHO_CONFIG_BOOLEAN_DEFAULTS = {
  includeSummary: true,
  includeRecentMessages: true,
  includePeerRepresentation: true,
  includePeerCard: true,
  includeAiPeerRepresentation: true,
  includeAiPeerCard: false,
  limitToSession: true,
  saveMessages: true,
  sessionPeerPrefix: false,
  dialecticDynamic: true,
};

export const HONCHO_CONFIG_STRING_DEFAULTS = {
  baseUrl: 'https://api.honcho.dev',
  peerName: '',
  aiPeer: '',
  recallMode: 'hybrid',
  sessionStrategy: 'platform',
  observationMode: 'directional',
  dialecticReasoningLevel: 'low',
  injectionFrequency: 'every-turn',
  reasoningLevelCap: '',
};

function numberSchema(bounds) {
  return {
    type: 'number',
    default: bounds.default,
    minimum: bounds.minimum,
    maximum: bounds.maximum,
  };
}

export function buildHonchoConfigSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      baseUrl: {
        type: 'string',
        default: HONCHO_CONFIG_STRING_DEFAULTS.baseUrl,
      },
      workspaceId: {
        type: 'string',
      },
      peerName: {
        type: 'string',
        default: HONCHO_CONFIG_STRING_DEFAULTS.peerName,
      },
      aiPeer: {
        type: 'string',
        default: HONCHO_CONFIG_STRING_DEFAULTS.aiPeer,
      },
      contextTokens: numberSchema(HONCHO_CONFIG_NUMBER_FIELDS.contextTokens),
      searchLimit: numberSchema(HONCHO_CONFIG_NUMBER_FIELDS.searchLimit),
      maxInjectedChars: numberSchema(
        HONCHO_CONFIG_NUMBER_FIELDS.maxInjectedChars,
      ),
      messageMaxChars: numberSchema(
        HONCHO_CONFIG_NUMBER_FIELDS.messageMaxChars,
      ),
      timeoutMs: numberSchema(HONCHO_CONFIG_NUMBER_FIELDS.timeoutMs),
      includeSummary: {
        type: 'boolean',
        default: HONCHO_CONFIG_BOOLEAN_DEFAULTS.includeSummary,
      },
      includeRecentMessages: {
        type: 'boolean',
        default: HONCHO_CONFIG_BOOLEAN_DEFAULTS.includeRecentMessages,
      },
      includePeerRepresentation: {
        type: 'boolean',
        default: HONCHO_CONFIG_BOOLEAN_DEFAULTS.includePeerRepresentation,
      },
      includePeerCard: {
        type: 'boolean',
        default: HONCHO_CONFIG_BOOLEAN_DEFAULTS.includePeerCard,
      },
      includeAiPeerRepresentation: {
        type: 'boolean',
        default: HONCHO_CONFIG_BOOLEAN_DEFAULTS.includeAiPeerRepresentation,
      },
      includeAiPeerCard: {
        type: 'boolean',
        default: HONCHO_CONFIG_BOOLEAN_DEFAULTS.includeAiPeerCard,
      },
      limitToSession: {
        type: 'boolean',
        default: HONCHO_CONFIG_BOOLEAN_DEFAULTS.limitToSession,
      },
      recallMode: {
        type: 'string',
        enum: [...HONCHO_RECALL_MODES],
        default: HONCHO_CONFIG_STRING_DEFAULTS.recallMode,
      },
      saveMessages: {
        type: 'boolean',
        default: HONCHO_CONFIG_BOOLEAN_DEFAULTS.saveMessages,
      },
      writeFrequency: {
        anyOf: [
          {
            type: 'string',
            enum: [...HONCHO_WRITE_FREQUENCY_MODES],
          },
          {
            type: 'integer',
            minimum: 1,
          },
        ],
        default: HONCHO_WRITE_FREQUENCY_DEFAULT,
      },
      sessionStrategy: {
        type: 'string',
        enum: [...HONCHO_SESSION_STRATEGIES],
        default: HONCHO_CONFIG_STRING_DEFAULTS.sessionStrategy,
      },
      sessionPeerPrefix: {
        type: 'boolean',
        default: HONCHO_CONFIG_BOOLEAN_DEFAULTS.sessionPeerPrefix,
      },
      sessions: {
        type: 'object',
        default: {},
        additionalProperties: {
          type: 'string',
        },
      },
      observationMode: {
        type: 'string',
        enum: [...HONCHO_OBSERVATION_MODES],
        default: HONCHO_CONFIG_STRING_DEFAULTS.observationMode,
      },
      observation: {
        type: 'object',
        additionalProperties: false,
        properties: {
          user: {
            type: 'object',
            additionalProperties: false,
            properties: {
              observeMe: {
                type: 'boolean',
              },
              observeOthers: {
                type: 'boolean',
              },
            },
          },
          ai: {
            type: 'object',
            additionalProperties: false,
            properties: {
              observeMe: {
                type: 'boolean',
              },
              observeOthers: {
                type: 'boolean',
              },
            },
          },
        },
      },
      dialecticReasoningLevel: {
        type: 'string',
        enum: [...HONCHO_REASONING_LEVELS],
        default: HONCHO_CONFIG_STRING_DEFAULTS.dialecticReasoningLevel,
      },
      dialecticDynamic: {
        type: 'boolean',
        default: HONCHO_CONFIG_BOOLEAN_DEFAULTS.dialecticDynamic,
      },
      dialecticMaxChars: numberSchema(
        HONCHO_CONFIG_NUMBER_FIELDS.dialecticMaxChars,
      ),
      dialecticMaxInputChars: numberSchema(
        HONCHO_CONFIG_NUMBER_FIELDS.dialecticMaxInputChars,
      ),
      injectionFrequency: {
        type: 'string',
        enum: [...HONCHO_INJECTION_FREQUENCIES],
        default: HONCHO_CONFIG_STRING_DEFAULTS.injectionFrequency,
      },
      contextCadence: numberSchema(HONCHO_CONFIG_NUMBER_FIELDS.contextCadence),
      dialecticCadence: numberSchema(
        HONCHO_CONFIG_NUMBER_FIELDS.dialecticCadence,
      ),
      reasoningLevelCap: {
        type: 'string',
        enum: ['', ...HONCHO_REASONING_LEVELS],
        default: HONCHO_CONFIG_STRING_DEFAULTS.reasoningLevelCap,
      },
    },
  };
}
