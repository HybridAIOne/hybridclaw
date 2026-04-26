import fs from 'node:fs';
import path from 'node:path';

const SUPPORTED_PROVIDERS = ['none', 'anthropic', 'openai', 'openai-compat'];
const SUPPORTED_MODES = ['block', 'rewrite', 'flag'];
const SUPPORTED_FAILURE_MODES = ['allow', 'block'];

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    const normalized = normalizeString(entry);
    if (normalized) out.push(normalized);
  }
  return out;
}

function ensureEnum(value, allowed, fallback) {
  const normalized = normalizeString(value).toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function ensureNumber(value, fallback, { min, max } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  let next = value;
  if (typeof min === 'number') next = Math.max(min, next);
  if (typeof max === 'number') next = Math.min(max, next);
  return next;
}

function compileRegexEntry(entry, errors) {
  if (!entry) return null;
  const trimmed = entry.trim();
  if (!trimmed) return null;
  const slashMatch = /^\/(.+)\/([gimsuy]*)$/.exec(trimmed);
  try {
    if (slashMatch) {
      return new RegExp(slashMatch[1], slashMatch[2] || 'i');
    }
    return new RegExp(trimmed, 'i');
  } catch (error) {
    errors.push(
      `brand-voice: invalid regex pattern ${JSON.stringify(entry)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

function resolveVoiceFile(voiceFile, runtime, logger) {
  if (!voiceFile) return '';
  let resolved = voiceFile;
  if (resolved.startsWith('~/')) {
    resolved = path.join(runtime.homeDir, resolved.slice(2));
  } else if (!path.isAbsolute(resolved)) {
    resolved = path.resolve(runtime.cwd, resolved);
  }
  try {
    const text = fs.readFileSync(resolved, 'utf-8');
    return String(text || '').trim();
  } catch (error) {
    logger.warn(
      { voiceFile, resolvedPath: resolved, error },
      'brand-voice: voiceFile not readable; ignoring',
    );
    return '';
  }
}

function resolveModelClientConfig(rawConfig, fallbackEnv, label) {
  const provider = ensureEnum(rawConfig?.provider, SUPPORTED_PROVIDERS, 'none');
  if (provider === 'none') {
    return { provider: 'none' };
  }
  const model = normalizeString(rawConfig?.model);
  if (!model) {
    throw new Error(
      `brand-voice: ${label} provider is "${provider}" but \`${label}.model\` is empty.`,
    );
  }
  const apiKeyEnv =
    normalizeString(rawConfig?.apiKeyEnv) || defaultApiKeyEnv(provider);
  const baseUrl =
    normalizeString(rawConfig?.baseUrl) || defaultBaseUrl(provider);
  const timeoutMs = ensureNumber(rawConfig?.timeoutMs, fallbackEnv.timeoutMs, {
    min: 1000,
    max: fallbackEnv.maxTimeoutMs,
  });
  const maxRetries = ensureNumber(rawConfig?.maxRetries, 1, { min: 0, max: 3 });
  return {
    provider,
    model,
    baseUrl,
    apiKeyEnv,
    timeoutMs,
    maxRetries,
  };
}

function defaultApiKeyEnv(provider) {
  if (provider === 'anthropic') return 'ANTHROPIC_API_KEY';
  if (provider === 'openai') return 'OPENAI_API_KEY';
  return 'BRAND_VOICE_API_KEY';
}

function defaultBaseUrl(provider) {
  if (provider === 'anthropic') return 'https://api.anthropic.com';
  if (provider === 'openai') return 'https://api.openai.com/v1';
  return '';
}

export function resolveBrandVoiceConfig(rawConfig, runtime, logger) {
  const errors = [];
  const enabled = rawConfig?.enabled !== false;
  const mode = ensureEnum(rawConfig?.mode, SUPPORTED_MODES, 'rewrite');
  const failureMode = ensureEnum(
    rawConfig?.failureMode,
    SUPPORTED_FAILURE_MODES,
    'allow',
  );
  const voice = normalizeString(rawConfig?.voice);
  const voiceFileText = resolveVoiceFile(
    normalizeString(rawConfig?.voiceFile),
    runtime,
    logger,
  );
  const bannedPhrases = normalizeStringArray(rawConfig?.bannedPhrases).map(
    (entry) => entry.toLowerCase(),
  );
  const bannedPatternStrings = normalizeStringArray(rawConfig?.bannedPatterns);
  const bannedPatterns = bannedPatternStrings
    .map((entry) => compileRegexEntry(entry, errors))
    .filter((value) => value !== null);
  const requirePhrases = normalizeStringArray(rawConfig?.requirePhrases);
  const blockMessage =
    normalizeString(rawConfig?.blockMessage) ||
    'Output blocked by brand-voice guard.';
  const minLength = ensureNumber(rawConfig?.minLength, 0, { min: 0 });

  const classifier = resolveModelClientConfig(
    rawConfig?.classifier,
    { timeoutMs: 8000, maxTimeoutMs: 60000 },
    'classifier',
  );
  const rewriter = resolveModelClientConfig(
    rawConfig?.rewriter,
    { timeoutMs: 12000, maxTimeoutMs: 120000 },
    'rewriter',
  );

  for (const error of errors) {
    logger.warn({ error }, 'brand-voice config issue');
  }

  return Object.freeze({
    enabled,
    mode,
    failureMode,
    voice,
    voiceFileText,
    bannedPhrases: Object.freeze(bannedPhrases),
    bannedPatternStrings: Object.freeze(bannedPatternStrings),
    bannedPatterns: Object.freeze(bannedPatterns),
    requirePhrases: Object.freeze(requirePhrases),
    blockMessage,
    minLength,
    classifier: Object.freeze(classifier),
    rewriter: Object.freeze(rewriter),
  });
}

export function buildVoiceBrief(config) {
  const sections = [];
  if (config.voice) sections.push(`Brand voice: ${config.voice}`);
  if (config.voiceFileText) sections.push(config.voiceFileText);
  if (config.bannedPhrases.length > 0) {
    sections.push(
      `Never use these phrases: ${config.bannedPhrases
        .map((p) => `"${p}"`)
        .join(', ')}.`,
    );
  }
  if (config.bannedPatternStrings.length > 0) {
    sections.push(
      `Avoid output that matches these patterns: ${config.bannedPatternStrings.join(
        ', ',
      )}.`,
    );
  }
  if (config.requirePhrases.length > 0) {
    sections.push(
      `Required phrases: ${config.requirePhrases.map((p) => `"${p}"`).join(', ')}.`,
    );
  }
  return sections.join('\n\n');
}
