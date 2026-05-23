import fs from 'node:fs';
import path from 'node:path';

const SUPPORTED_MODEL_SOURCES = ['default', 'auxiliary', 'model'];
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

function ensureModelSource(value, label) {
  const normalized = normalizeString(value).toLowerCase();
  if (!normalized) return 'default';
  if (SUPPORTED_MODEL_SOURCES.includes(normalized)) return normalized;
  throw new Error(
    `output-guard: unsupported ${label} model source "${normalized}".`,
  );
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
      `output-guard: invalid regex pattern ${JSON.stringify(entry)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

function resolvePolicyFile(policyFile, runtime, logger) {
  if (!policyFile) return '';
  let resolved = policyFile;
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
      { policyFile, resolvedPath: resolved, error },
      'output-guard: policyFile not readable; ignoring',
    );
    return '';
  }
}

function resolveModelSourceConfig(rawConfig, label) {
  const provider = ensureModelSource(rawConfig?.provider, label);
  const model = normalizeString(rawConfig?.model);
  if (provider === 'model' && !model) {
    throw new Error(
      `output-guard: ${label} model source is "${provider}" but \`${label}.model\` is empty.`,
    );
  }
  return { provider, model: provider === 'model' ? model : '' };
}

export function resolveOutputGuardConfig(rawConfig, runtime, logger) {
  const errors = [];
  const enabled = rawConfig?.enabled !== false;
  const mode = ensureEnum(rawConfig?.mode, SUPPORTED_MODES, 'rewrite');
  const failureMode = ensureEnum(
    rawConfig?.failureMode,
    SUPPORTED_FAILURE_MODES,
    'allow',
  );
  const policy = normalizeString(rawConfig?.policy);
  const doList = normalizeStringArray(rawConfig?.doList);
  const dontList = normalizeStringArray(rawConfig?.dontList);
  const policyFileText = resolvePolicyFile(
    normalizeString(rawConfig?.policyFile),
    runtime,
    logger,
  );
  const bannedPhrases = normalizeStringArray(rawConfig?.bannedPhrases).map(
    (entry) => entry.toLowerCase(),
  );
  const bannedPatternEntries = normalizeStringArray(rawConfig?.bannedPatterns)
    .map((source) => {
      const pattern = compileRegexEntry(source, errors);
      return pattern === null ? null : { source, pattern };
    })
    .filter((value) => value !== null);
  const requirePhrases = normalizeStringArray(rawConfig?.requirePhrases);
  const blockMessage =
    normalizeString(rawConfig?.blockMessage) ||
    'Output blocked by output guard.';
  const minLength = ensureNumber(rawConfig?.minLength, 0, { min: 0 });

  const classifier = resolveModelSourceConfig(
    rawConfig?.classifier,
    'classifier',
  );
  const rewriter = resolveModelSourceConfig(rawConfig?.rewriter, 'rewriter');

  for (const error of errors) {
    logger.warn({ error }, 'output-guard config issue');
  }

  return Object.freeze({
    enabled,
    mode,
    failureMode,
    policy,
    doList: Object.freeze(doList),
    dontList: Object.freeze(dontList),
    policyFileText,
    bannedPhrases: Object.freeze(bannedPhrases),
    bannedPatterns: Object.freeze(
      bannedPatternEntries.map((entry) => Object.freeze(entry)),
    ),
    requirePhrases: Object.freeze(requirePhrases),
    blockMessage,
    minLength,
    classifier: Object.freeze(classifier),
    rewriter: Object.freeze(rewriter),
  });
}

export function buildPolicyBrief(config) {
  const sections = [];
  if (config.policy) sections.push(`Output policy: ${config.policy}`);
  if (config.policyFileText) sections.push(config.policyFileText);
  if (config.doList.length > 0) {
    sections.push(
      `Do:\n${config.doList.map((entry) => `- ${entry}`).join('\n')}`,
    );
  }
  if (config.dontList.length > 0) {
    sections.push(
      `Don't:\n${config.dontList.map((entry) => `- ${entry}`).join('\n')}`,
    );
  }
  if (config.bannedPhrases.length > 0) {
    sections.push(
      `Never use these phrases: ${config.bannedPhrases
        .map((p) => `"${p}"`)
        .join(', ')}.`,
    );
  }
  if (config.bannedPatterns.length > 0) {
    sections.push(
      `Avoid output that matches these patterns: ${config.bannedPatterns
        .map((entry) => entry.source)
        .join(', ')}.`,
    );
  }
  if (config.requirePhrases.length > 0) {
    sections.push(
      `Required phrases: ${config.requirePhrases.map((p) => `"${p}"`).join(', ')}.`,
    );
  }
  return sections.join('\n\n');
}
