import {
  getRuntimeConfig,
  type RuntimeConfig,
  type RuntimePluginConfigEntry,
  runtimeConfigPath,
  saveRuntimeConfig,
} from '../config/runtime-config.js';
import { listRuntimeConfigRevisions } from '../config/runtime-config-revisions.js';
import { logger } from '../logger.js';
import { callAuxiliaryModel } from '../providers/auxiliary.js';
import { isRecord } from '../utils/type-guards.js';
import { reloadPluginRuntime } from './gateway-plugin-service.js';
import type {
  GatewayAdminOutputGuardModelConfig,
  GatewayAdminOutputGuardPreviewClassifier,
  GatewayAdminOutputGuardPreviewResponse,
  GatewayAdminOutputGuardPreviewViolation,
  GatewayAdminOutputGuardProfile,
  GatewayAdminOutputGuardProfileResponse,
  GatewayAdminOutputGuardProfileUpdateResponse,
  GatewayAdminOutputGuardRevision,
} from './gateway-types.js';

const OUTPUT_GUARD_PLUGIN_ID = 'output-guard';
const SUPPORTED_MODES = ['block', 'rewrite', 'flag'] as const;
const SUPPORTED_MODEL_SOURCES = ['default', 'auxiliary', 'model'] as const;
const SUPPORTED_FAILURE_MODES = ['allow', 'block'] as const;
const OUTPUT_GUARD_REVISION_ROUTE = 'api.admin.output-guard.profile';
const OUTPUT_GUARD_MODEL_TIMEOUT_MS = 300_000;
const MODEL_PROVIDER_PREFIXES = [
  'openai-codex',
  'anthropic',
  'openrouter',
  'mistral',
  'huggingface',
  'gemini',
  'deepseek',
  'xai',
  'zai',
  'kimi',
  'minimax',
  'dashscope',
  'xiaomi',
  'kilo',
  'ollama',
  'lmstudio',
  'llamacpp',
  'vllm',
  'browser',
] as const;
const MAX_PROFILE_LIST_ITEMS = 200;
const MAX_PREVIEW_SAMPLE_CHARS = 50_000;
const PREVIEW_SCORE = {
  max: 100,
  hardViolationPenalty: 30,
  missingRequiredPenalty: 12,
  compliantMin: 90,
  needsReviewMin: 70,
} as const;

type OutputGuardModelSource = (typeof SUPPORTED_MODEL_SOURCES)[number];

type OutputGuardFailureMode = (typeof SUPPORTED_FAILURE_MODES)[number];

function inferModelProvider(
  model: string | undefined,
): (typeof MODEL_PROVIDER_PREFIXES)[number] | undefined {
  const normalized = String(model || '')
    .trim()
    .toLowerCase();
  if (!normalized) return undefined;
  return MODEL_PROVIDER_PREFIXES.find((provider) =>
    normalized.startsWith(`${provider}/`),
  );
}

interface OutputGuardModelClientConfig {
  provider: OutputGuardModelSource;
  model: string;
}

interface OutputGuardPreviewRuntimeConfig
  extends Omit<GatewayAdminOutputGuardProfile, 'classifier' | 'rewriter'> {
  failureMode: OutputGuardFailureMode;
  classifier: OutputGuardModelClientConfig;
  rewriter: OutputGuardModelClientConfig;
}

interface ClassifierVerdict {
  verdict: 'compliant' | 'non_compliant';
  reasons: string[];
  severity: 'low' | 'medium' | 'high';
}

// The gateway cannot import bundled plugin JS directly, so the admin preview
// mirrors plugins/output-guard/src/{config,guard,llm,rules}. Keep provider
// defaults, prompts, verdict parsing, and rule summaries aligned with the
// plugin runtime when either side changes.

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeStringArray(value: unknown, fieldLabel: string): string[] {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_PROFILE_LIST_ITEMS) {
    throw new Error(
      `${fieldLabel} cannot contain more than ${MAX_PROFILE_LIST_ITEMS} entries.`,
    );
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const normalized = normalizeString(entry);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function normalizeMode(value: unknown): GatewayAdminOutputGuardProfile['mode'] {
  const normalized = normalizeString(value).toLowerCase();
  return SUPPORTED_MODES.includes(
    normalized as GatewayAdminOutputGuardProfile['mode'],
  )
    ? (normalized as GatewayAdminOutputGuardProfile['mode'])
    : 'rewrite';
}

function normalizeModelSource(value: unknown): OutputGuardModelSource {
  const normalized = normalizeString(value).toLowerCase();
  if (!normalized) return 'default';
  if (SUPPORTED_MODEL_SOURCES.includes(normalized as OutputGuardModelSource)) {
    return normalized as OutputGuardModelSource;
  }
  throw new Error(`Unsupported output guard model source: ${normalized}`);
}

function normalizeFailureMode(value: unknown): OutputGuardFailureMode {
  const normalized = normalizeString(value).toLowerCase();
  return SUPPORTED_FAILURE_MODES.includes(normalized as OutputGuardFailureMode)
    ? (normalized as OutputGuardFailureMode)
    : 'allow';
}

function defaultModelConfig(): GatewayAdminOutputGuardModelConfig {
  return {
    provider: 'default',
    model: '',
  };
}

function normalizeModelConfig(
  value: unknown,
  label: string,
): OutputGuardModelClientConfig {
  const raw = isRecord(value) ? value : {};
  const provider = normalizeModelSource(raw.provider);
  const model = normalizeString(raw.model);
  if (provider === 'model' && !model) {
    throw new Error(`Output guard ${label} model is required.`);
  }
  return { provider, model: provider === 'model' ? model : '' };
}

function normalizeProfileModelConfig(
  value: unknown,
): GatewayAdminOutputGuardModelConfig {
  if (value === undefined) return defaultModelConfig();
  const raw = isRecord(value) ? value : {};
  const provider = normalizeModelSource(raw.provider);
  const model = normalizeString(raw.model);
  return { provider, model: provider === 'model' ? model : '' };
}

function runtimeModelConfigToProfile(
  value: unknown,
): GatewayAdminOutputGuardModelConfig {
  const raw = isRecord(value) ? value : {};
  const provider = normalizeModelSource(raw.provider);
  const model = normalizeString(raw.model);
  return { provider, model: provider === 'model' ? model : '' };
}

function findOutputGuardEntry(
  config: RuntimeConfig,
): RuntimePluginConfigEntry | undefined {
  return config.plugins.list.find(
    (entry) => entry.id === OUTPUT_GUARD_PLUGIN_ID,
  );
}

function ensureOutputGuardEntry(
  config: RuntimeConfig,
): RuntimePluginConfigEntry {
  const existing = findOutputGuardEntry(config);
  if (existing) return existing;
  const entry: RuntimePluginConfigEntry = {
    id: OUTPUT_GUARD_PLUGIN_ID,
    enabled: true,
    config: {},
  };
  config.plugins.list.push(entry);
  return entry;
}

function profileFromEntry(
  entry: RuntimePluginConfigEntry | undefined,
): GatewayAdminOutputGuardProfile {
  const pluginConfig = isRecord(entry?.config) ? entry.config : {};
  return {
    ...normalizeProfile(pluginConfig),
    enabled: entry ? entry.enabled !== false : false,
    classifier: runtimeModelConfigToProfile(pluginConfig.classifier),
    rewriter: runtimeModelConfigToProfile(pluginConfig.rewriter),
  };
}

function normalizeProfile(value: unknown): GatewayAdminOutputGuardProfile {
  const raw = isRecord(value) ? value : {};
  return {
    enabled: raw.enabled !== false,
    mode: normalizeMode(raw.mode),
    policy: normalizeString(raw.policy),
    doList: normalizeStringArray(raw.doList, 'Do list'),
    dontList: normalizeStringArray(raw.dontList, "Don't list"),
    bannedPhrases: normalizeStringArray(raw.bannedPhrases, 'Banned phrases'),
    bannedPatterns: normalizeStringArray(raw.bannedPatterns, 'Banned patterns'),
    requirePhrases: normalizeStringArray(
      raw.requirePhrases,
      'Required phrases',
    ),
    classifier: normalizeProfileModelConfig(raw.classifier),
    rewriter: normalizeProfileModelConfig(raw.rewriter),
  };
}

function readProfileFromConfig(
  config: RuntimeConfig,
): GatewayAdminOutputGuardProfile {
  return profileFromEntry(findOutputGuardEntry(config));
}

function profilesEqual(
  left: GatewayAdminOutputGuardProfile,
  right: GatewayAdminOutputGuardProfile,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function listOutputGuardRevisions(): GatewayAdminOutputGuardRevision[] {
  return listRuntimeConfigRevisions(runtimeConfigPath())
    .filter((revision) => revision.route === OUTPUT_GUARD_REVISION_ROUTE)
    .slice(0, 12)
    .map((revision) => ({
      id: revision.id,
      createdAt: revision.createdAt,
      actor: revision.actor,
      route: revision.route,
      source: revision.source,
      md5: revision.md5,
    }));
}

function buildProfileResponse(
  config: RuntimeConfig,
): GatewayAdminOutputGuardProfileResponse {
  return {
    profile: readProfileFromConfig(config),
    revisions: listOutputGuardRevisions(),
  };
}

function applyProfileToConfig(
  config: RuntimeConfig,
  profile: GatewayAdminOutputGuardProfile,
): void {
  const entry = ensureOutputGuardEntry(config);
  const existingConfig = isRecord(entry.config) ? entry.config : {};
  entry.enabled = profile.enabled;
  entry.config = {
    ...existingConfig,
    mode: profile.mode,
    policy: profile.policy,
    doList: profile.doList,
    dontList: profile.dontList,
    bannedPhrases: profile.bannedPhrases,
    bannedPatterns: profile.bannedPatterns,
    requirePhrases: profile.requirePhrases,
    classifier: buildRuntimeModelConfig(profile.classifier),
    rewriter: buildRuntimeModelConfig(profile.rewriter),
  };
}

function buildRuntimeModelConfig(
  modelConfig: GatewayAdminOutputGuardModelConfig,
): Record<string, unknown> {
  if (modelConfig.provider === 'model') {
    return {
      provider: 'model',
      model: modelConfig.model,
    };
  }
  return {
    provider: modelConfig.provider,
  };
}

function buildPreviewRuntimeConfig(
  baseConfig: RuntimeConfig,
  profile: GatewayAdminOutputGuardProfile,
): OutputGuardPreviewRuntimeConfig {
  const entry = findOutputGuardEntry(baseConfig);
  const pluginConfig = isRecord(entry?.config) ? entry.config : {};
  return {
    ...profile,
    failureMode: normalizeFailureMode(pluginConfig.failureMode),
    classifier: normalizeModelConfig(
      buildRuntimeModelConfig(profile.classifier),
      'classifier',
    ),
    rewriter: normalizeModelConfig(
      buildRuntimeModelConfig(profile.rewriter),
      'rewriter',
    ),
  };
}

function buildPolicyBrief(profile: OutputGuardPreviewRuntimeConfig): string {
  const sections: string[] = [];
  if (profile.policy) sections.push(`Output policy: ${profile.policy}`);
  if (profile.doList.length > 0) {
    sections.push(
      `Do:\n${profile.doList.map((entry) => `- ${entry}`).join('\n')}`,
    );
  }
  if (profile.dontList.length > 0) {
    sections.push(
      `Don't:\n${profile.dontList.map((entry) => `- ${entry}`).join('\n')}`,
    );
  }
  if (profile.bannedPhrases.length > 0) {
    sections.push(
      `Never use these phrases: ${profile.bannedPhrases.map((phrase) => `"${phrase}"`).join(', ')}.`,
    );
  }
  if (profile.bannedPatterns.length > 0) {
    sections.push(
      `Avoid output that matches these patterns: ${profile.bannedPatterns.join(', ')}.`,
    );
  }
  if (profile.requirePhrases.length > 0) {
    sections.push(
      `Required phrases: ${profile.requirePhrases.map((phrase) => `"${phrase}"`).join(', ')}.`,
    );
  }
  return sections.join('\n\n');
}

function compilePattern(
  source: string,
): { pattern: RegExp; detail: string } | null {
  // Keep slash-pattern parsing aligned with plugins/output-guard/src/config.js.
  const trimmed = source.trim();
  if (!trimmed) return null;
  const slashMatch = /^\/(.+)\/([gimsuy]*)$/.exec(trimmed);
  try {
    return {
      pattern: slashMatch
        ? new RegExp(slashMatch[1], slashMatch[2] || 'i')
        : new RegExp(trimmed, 'i'),
      detail: source,
    };
  } catch {
    return null;
  }
}

function listInvalidPatterns(patterns: string[]): string[] {
  return patterns.filter((source) => compilePattern(source) === null);
}

function assertValidBannedPatterns(
  profile: GatewayAdminOutputGuardProfile,
): void {
  const invalidPatterns = listInvalidPatterns(profile.bannedPatterns);
  if (invalidPatterns.length === 0) return;
  throw new Error(
    `Invalid banned pattern${invalidPatterns.length === 1 ? '' : 's'}: ${invalidPatterns.join(', ')}`,
  );
}

function assertValidModelConfig(
  config: GatewayAdminOutputGuardModelConfig,
  label: string,
): void {
  if (config.provider !== 'model' || config.model) {
    return;
  }
  throw new Error(`Output guard ${label} model is required.`);
}

function phraseAppears(text: string, phrase: string): boolean {
  return text.toLowerCase().includes(phrase.toLowerCase());
}

function scoreViolations(
  profile: OutputGuardPreviewRuntimeConfig,
  sample: string,
): GatewayAdminOutputGuardPreviewViolation[] {
  const violations: GatewayAdminOutputGuardPreviewViolation[] = [];
  for (const phrase of profile.bannedPhrases) {
    if (phraseAppears(sample, phrase)) {
      violations.push({ kind: 'banned_phrase', detail: phrase });
    }
  }
  for (const source of profile.bannedPatterns) {
    const compiled = compilePattern(source);
    if (compiled?.pattern.test(sample)) {
      violations.push({ kind: 'banned_pattern', detail: compiled.detail });
    }
  }
  for (const phrase of profile.requirePhrases) {
    if (!phraseAppears(sample, phrase)) {
      violations.push({ kind: 'missing_required', detail: phrase });
    }
  }
  return violations;
}

function summarizeViolations(
  violations: GatewayAdminOutputGuardPreviewViolation[],
): string {
  if (violations.length === 0) return '';
  const grouped = new Map<string, string[]>();
  for (const violation of violations) {
    const details = grouped.get(violation.kind) ?? [];
    details.push(violation.detail);
    grouped.set(violation.kind, details);
  }
  const out: string[] = [];
  for (const [kind, details] of grouped.entries()) {
    if (kind === 'banned_phrase') {
      out.push(
        `banned phrases: ${details.map((detail) => `"${detail}"`).join(', ')}`,
      );
    } else if (kind === 'banned_pattern') {
      out.push(`banned patterns: ${details.join(', ')}`);
    } else if (kind === 'missing_required') {
      out.push(
        `missing required phrases: ${details.map((detail) => `"${detail}"`).join(', ')}`,
      );
    }
  }
  return out.join('; ');
}

function buildClassifierPrompt(
  profile: OutputGuardPreviewRuntimeConfig,
  sample: string,
  violations: GatewayAdminOutputGuardPreviewViolation[],
): string {
  const sections = [
    `Output guard brief:\n${buildPolicyBrief(profile) || '(none provided)'}`,
  ];
  if (violations.length > 0) {
    sections.push(
      `Detected rule violations: ${summarizeViolations(violations)}`,
    );
  }
  sections.push(`Assistant response:\n${sample}`);
  sections.push('Reply with the JSON verdict object only.');
  return sections.join('\n\n');
}

async function callClassifierModel(
  client: OutputGuardModelClientConfig,
  userPrompt: string,
  fallbackModel: string,
): Promise<{ content: string; model: string }> {
  if (client.provider === 'model' && !client.model) {
    throw new Error('Output guard classifier model is required.');
  }
  const systemPrompt = [
    'You are an output guard compliance reviewer.',
    'You receive an assistant response and an output guard brief.',
    "Treat the output guard brief, policy, Do list, Don't list, banned rules, and required phrases as mandatory output requirements.",
    'Return non_compliant when the response does not clearly follow the requested style, tone, phrasing, required content, or avoidance rules.',
    'Reply with a single JSON object on one line: {"verdict":"compliant"|"non_compliant","reasons":[string],"severity":"low"|"medium"|"high"}',
    'Do not include any prose outside the JSON.',
  ].join(' ');
  const model =
    client.provider === 'default'
      ? fallbackModel
      : client.provider === 'model'
        ? client.model
        : undefined;
  const provider =
    client.provider === 'auxiliary'
      ? undefined
      : (inferModelProvider(model) ??
        (client.provider === 'default' ? 'auto' : undefined));
  const result = await callAuxiliaryModel({
    task: 'skills_hub',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    provider,
    model,
    fallbackModel,
    fallbackEnableRag: false,
    maxTokens: 1024,
    temperature: 0,
    timeoutMs: OUTPUT_GUARD_MODEL_TIMEOUT_MS,
  });
  return { content: result.content, model: result.model };
}

function parseClassifierVerdict(text: string): ClassifierVerdict | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const jsonMatch =
    /^\{[\s\S]*\}$/m.exec(trimmed) ||
    /\{[\s\S]*"verdict"[\s\S]*\}/.exec(trimmed);
  const candidate = jsonMatch ? jsonMatch[0] : trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const verdict = normalizeString(parsed.verdict).toLowerCase();
  if (verdict !== 'compliant' && verdict !== 'non_compliant') return null;
  const reasons = Array.isArray(parsed.reasons)
    ? parsed.reasons.filter(
        (entry): entry is string => typeof entry === 'string',
      )
    : [];
  const severity = normalizeString(parsed.severity).toLowerCase();
  return {
    verdict,
    reasons,
    severity:
      severity === 'low' || severity === 'medium' || severity === 'high'
        ? severity
        : 'medium',
  };
}

function scoreClassifierVerdict(verdict: ClassifierVerdict): number {
  if (verdict.verdict === 'compliant') return PREVIEW_SCORE.max;
  if (verdict.severity === 'low') return 65;
  if (verdict.severity === 'medium') return 35;
  return 0;
}

async function runPreviewClassifier(
  config: OutputGuardPreviewRuntimeConfig,
  sample: string,
  violations: GatewayAdminOutputGuardPreviewViolation[],
): Promise<GatewayAdminOutputGuardPreviewClassifier> {
  const { classifier } = config;
  try {
    const result = await callClassifierModel(
      classifier,
      buildClassifierPrompt(config, sample, violations),
      getRuntimeConfig().hybridai?.defaultModel ?? '',
    );
    const verdict = parseClassifierVerdict(result.content);
    if (!verdict) {
      return {
        provider: classifier.provider,
        status: 'unparseable',
        verdict: null,
        severity: null,
        reasons: [],
        message: 'Classifier returned a response that could not be parsed.',
        model: result.model,
      };
    }
    return {
      provider: classifier.provider,
      status: 'evaluated',
      verdict: verdict.verdict,
      severity: verdict.severity,
      reasons: verdict.reasons,
      message: null,
      model: result.model,
    };
  } catch (error) {
    return {
      provider: classifier.provider,
      status: 'unavailable',
      verdict: null,
      severity: null,
      reasons: [],
      message: error instanceof Error ? error.message : String(error),
      model: null,
    };
  }
}

function scoreOutputGuardPreview(
  config: OutputGuardPreviewRuntimeConfig,
  sample: string,
  classifier: GatewayAdminOutputGuardPreviewClassifier,
): GatewayAdminOutputGuardPreviewResponse {
  const violations = scoreViolations(config, sample);
  let score: number = PREVIEW_SCORE.max;
  for (const violation of violations) {
    if (
      violation.kind === 'banned_phrase' ||
      violation.kind === 'banned_pattern'
    ) {
      score -= PREVIEW_SCORE.hardViolationPenalty;
    } else {
      score -= PREVIEW_SCORE.missingRequiredPenalty;
    }
  }
  const ruleScore = Math.max(0, Math.min(PREVIEW_SCORE.max, score));
  const classifierScore =
    classifier.status === 'evaluated' &&
    classifier.verdict !== null &&
    classifier.severity !== null
      ? scoreClassifierVerdict({
          verdict: classifier.verdict,
          reasons: classifier.reasons,
          severity: classifier.severity,
        })
      : null;
  const failureModeScore =
    classifier.status === 'unavailable' && config.failureMode === 'block'
      ? 0
      : null;
  score =
    classifierScore === null
      ? (failureModeScore ?? ruleScore)
      : Math.min(ruleScore, classifierScore);
  const verdict =
    violations.length > 0 ||
    classifier.verdict === 'non_compliant' ||
    failureModeScore === 0
      ? 'non_compliant'
      : score >= PREVIEW_SCORE.compliantMin
        ? 'compliant'
        : score >= PREVIEW_SCORE.needsReviewMin
          ? 'needs_review'
          : 'non_compliant';

  return {
    score,
    ruleScore,
    scoreSource:
      classifier.status === 'evaluated' || failureModeScore === 0
        ? 'classifier'
        : 'rules',
    verdict,
    violations,
    classifier,
  };
}

export function getGatewayAdminOutputGuardProfile(): GatewayAdminOutputGuardProfileResponse {
  return buildProfileResponse(getRuntimeConfig());
}

export async function updateGatewayAdminOutputGuardProfile(
  body: unknown,
): Promise<GatewayAdminOutputGuardProfileUpdateResponse> {
  const previousConfig = getRuntimeConfig();
  const nextConfig = structuredClone(previousConfig);
  const previousProfile = readProfileFromConfig(previousConfig);
  const profile = normalizeProfile(isRecord(body) ? body.profile : body);
  assertValidBannedPatterns(profile);
  assertValidModelConfig(profile.classifier, 'classifier');
  assertValidModelConfig(profile.rewriter, 'rewriter');
  applyProfileToConfig(nextConfig, profile);

  const changed = !profilesEqual(previousProfile, profile);
  if (changed) {
    saveRuntimeConfig(nextConfig, {
      route: OUTPUT_GUARD_REVISION_ROUTE,
      source: 'admin-console',
    });
    const reloadResult = await reloadPluginRuntime();
    if (!reloadResult.ok) {
      try {
        saveRuntimeConfig(previousConfig, {
          route: `${OUTPUT_GUARD_REVISION_ROUTE}.rollback`,
          source: 'admin-console',
        });
        const rollbackReloadResult = await reloadPluginRuntime();
        if (!rollbackReloadResult.ok) {
          logger.warn(
            {
              reloadMessage: reloadResult.message,
              rollbackReloadMessage: rollbackReloadResult.message,
            },
            'Output guard runtime rollback reload failed',
          );
        }
      } catch (error) {
        logger.error(
          { error, reloadMessage: reloadResult.message },
          'Output guard runtime rollback failed',
        );
      }
      throw new Error(reloadResult.message);
    }
    return {
      ...buildProfileResponse(nextConfig),
      changed,
      reloadMessage: reloadResult.message,
    };
  }

  return {
    ...buildProfileResponse(previousConfig),
    changed,
    reloadMessage: 'Plugin runtime unchanged.',
  };
}

export async function previewGatewayAdminOutputGuardProfile(
  body: unknown,
): Promise<GatewayAdminOutputGuardPreviewResponse> {
  const raw = isRecord(body) ? body : {};
  const sample = normalizeString(raw.sample);
  if (!sample) {
    throw new Error('Sample output is required.');
  }
  if (sample.length > MAX_PREVIEW_SAMPLE_CHARS) {
    throw new Error(
      `Sample output cannot exceed ${MAX_PREVIEW_SAMPLE_CHARS} characters.`,
    );
  }
  const profile =
    raw.profile === undefined
      ? getGatewayAdminOutputGuardProfile().profile
      : normalizeProfile(raw.profile);
  assertValidBannedPatterns(profile);
  assertValidModelConfig(profile.classifier, 'classifier');
  assertValidModelConfig(profile.rewriter, 'rewriter');
  const runtimeConfig = buildPreviewRuntimeConfig(getRuntimeConfig(), profile);
  const violations = scoreViolations(runtimeConfig, sample);
  const classifier = await runPreviewClassifier(
    runtimeConfig,
    sample,
    violations,
  );
  return scoreOutputGuardPreview(runtimeConfig, sample, classifier);
}
