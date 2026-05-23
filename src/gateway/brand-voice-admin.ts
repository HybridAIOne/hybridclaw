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
import { reloadPluginRuntime } from './gateway-plugin-service.js';
import type {
  GatewayAdminBrandVoiceClassifierConfig,
  GatewayAdminBrandVoicePreviewClassifier,
  GatewayAdminBrandVoicePreviewResponse,
  GatewayAdminBrandVoicePreviewViolation,
  GatewayAdminBrandVoiceProfile,
  GatewayAdminBrandVoiceProfileResponse,
  GatewayAdminBrandVoiceProfileUpdateResponse,
  GatewayAdminBrandVoiceRevision,
} from './gateway-types.js';

const BRAND_VOICE_PLUGIN_ID = 'brand-voice';
const SUPPORTED_MODES = ['block', 'rewrite', 'flag'] as const;
const SUPPORTED_CLASSIFIER_PROVIDERS = [
  'rules',
  'default',
  'auxiliary',
] as const;
const SUPPORTED_FAILURE_MODES = ['allow', 'block'] as const;
const BRAND_VOICE_REVISION_ROUTE = 'api.admin.brand-voice.profile';
const MAX_PROFILE_LIST_ITEMS = 200;
const MAX_PREVIEW_SAMPLE_CHARS = 50_000;
const PREVIEW_SCORE = {
  max: 100,
  hardViolationPenalty: 30,
  missingRequiredPenalty: 12,
  onBrandMin: 90,
  needsReviewMin: 70,
} as const;

type BrandVoiceClassifierProvider =
  (typeof SUPPORTED_CLASSIFIER_PROVIDERS)[number];

type BrandVoiceFailureMode = (typeof SUPPORTED_FAILURE_MODES)[number];

interface BrandVoiceModelClientConfig {
  provider: BrandVoiceClassifierProvider;
}

interface BrandVoicePreviewRuntimeConfig
  extends Omit<GatewayAdminBrandVoiceProfile, 'classifier'> {
  failureMode: BrandVoiceFailureMode;
  classifier: BrandVoiceModelClientConfig;
}

interface ClassifierVerdict {
  verdict: 'on_brand' | 'off_brand';
  reasons: string[];
  severity: 'low' | 'medium' | 'high';
}

// The gateway cannot import bundled plugin JS directly, so the admin preview
// mirrors plugins/brand-voice/src/{config,guard,llm,rules}. Keep provider
// defaults, prompts, verdict parsing, and rule summaries aligned with the
// plugin runtime when either side changes.

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

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

function normalizeMode(value: unknown): GatewayAdminBrandVoiceProfile['mode'] {
  const normalized = normalizeString(value).toLowerCase();
  return SUPPORTED_MODES.includes(
    normalized as GatewayAdminBrandVoiceProfile['mode'],
  )
    ? (normalized as GatewayAdminBrandVoiceProfile['mode'])
    : 'rewrite';
}

function normalizeClassifierProvider(
  value: unknown,
): BrandVoiceClassifierProvider {
  const normalized = normalizeString(value).toLowerCase();
  return SUPPORTED_CLASSIFIER_PROVIDERS.includes(
    normalized as BrandVoiceClassifierProvider,
  )
    ? (normalized as BrandVoiceClassifierProvider)
    : 'rules';
}

function normalizeFailureMode(value: unknown): BrandVoiceFailureMode {
  const normalized = normalizeString(value).toLowerCase();
  return SUPPORTED_FAILURE_MODES.includes(normalized as BrandVoiceFailureMode)
    ? (normalized as BrandVoiceFailureMode)
    : 'allow';
}

function defaultClassifierConfig(): GatewayAdminBrandVoiceClassifierConfig {
  return {
    provider: 'rules',
  };
}

function normalizeClassifierConfig(
  value: unknown,
): BrandVoiceModelClientConfig {
  const raw = isRecord(value) ? value : {};
  const provider = normalizeClassifierProvider(raw.provider);
  return { provider };
}

function normalizeProfileClassifier(
  value: unknown,
): GatewayAdminBrandVoiceClassifierConfig {
  if (value === undefined) return defaultClassifierConfig();
  const raw = isRecord(value) ? value : {};
  const provider = normalizeClassifierProvider(raw.provider);
  return { provider };
}

function runtimeClassifierToProfile(
  value: unknown,
): GatewayAdminBrandVoiceClassifierConfig {
  const raw = isRecord(value) ? value : {};
  const provider = normalizeClassifierProvider(raw.provider);
  return { provider };
}

function findBrandVoiceEntry(
  config: RuntimeConfig,
): RuntimePluginConfigEntry | undefined {
  return config.plugins.list.find(
    (entry) => entry.id === BRAND_VOICE_PLUGIN_ID,
  );
}

function ensureBrandVoiceEntry(
  config: RuntimeConfig,
): RuntimePluginConfigEntry {
  const existing = findBrandVoiceEntry(config);
  if (existing) return existing;
  const entry: RuntimePluginConfigEntry = {
    id: BRAND_VOICE_PLUGIN_ID,
    enabled: true,
    config: {},
  };
  config.plugins.list.push(entry);
  return entry;
}

function profileFromEntry(
  entry: RuntimePluginConfigEntry | undefined,
): GatewayAdminBrandVoiceProfile {
  const pluginConfig = isRecord(entry?.config) ? entry.config : {};
  return {
    ...normalizeProfile(pluginConfig),
    enabled: entry?.enabled !== false,
    classifier: runtimeClassifierToProfile(pluginConfig.classifier),
  };
}

function normalizeProfile(value: unknown): GatewayAdminBrandVoiceProfile {
  const raw = isRecord(value) ? value : {};
  return {
    enabled: raw.enabled !== false,
    mode: normalizeMode(raw.mode),
    voice: normalizeString(raw.voice),
    doList: normalizeStringArray(raw.doList, 'Do list'),
    dontList: normalizeStringArray(raw.dontList, "Don't list"),
    bannedPhrases: normalizeStringArray(raw.bannedPhrases, 'Banned phrases'),
    bannedPatterns: normalizeStringArray(raw.bannedPatterns, 'Banned patterns'),
    requirePhrases: normalizeStringArray(
      raw.requirePhrases,
      'Required phrases',
    ),
    classifier: normalizeProfileClassifier(raw.classifier),
  };
}

function readProfileFromConfig(
  config: RuntimeConfig,
): GatewayAdminBrandVoiceProfile {
  return profileFromEntry(findBrandVoiceEntry(config));
}

function profilesEqual(
  left: GatewayAdminBrandVoiceProfile,
  right: GatewayAdminBrandVoiceProfile,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function listBrandVoiceRevisions(): GatewayAdminBrandVoiceRevision[] {
  return listRuntimeConfigRevisions(runtimeConfigPath())
    .filter((revision) => revision.route === BRAND_VOICE_REVISION_ROUTE)
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
): GatewayAdminBrandVoiceProfileResponse {
  return {
    profile: readProfileFromConfig(config),
    revisions: listBrandVoiceRevisions(),
  };
}

function applyProfileToConfig(
  config: RuntimeConfig,
  profile: GatewayAdminBrandVoiceProfile,
): void {
  const entry = ensureBrandVoiceEntry(config);
  const existingConfig = isRecord(entry.config) ? entry.config : {};
  entry.enabled = profile.enabled;
  entry.config = {
    ...existingConfig,
    mode: profile.mode,
    voice: profile.voice,
    doList: profile.doList,
    dontList: profile.dontList,
    bannedPhrases: profile.bannedPhrases,
    bannedPatterns: profile.bannedPatterns,
    requirePhrases: profile.requirePhrases,
    classifier: buildRuntimeClassifierConfig(profile.classifier),
  };
}

function buildRuntimeClassifierConfig(
  classifier: GatewayAdminBrandVoiceClassifierConfig,
): Record<string, unknown> {
  if (classifier.provider === 'rules') {
    return { provider: 'rules' };
  }
  return {
    provider: classifier.provider,
  };
}

function buildPreviewRuntimeConfig(
  baseConfig: RuntimeConfig,
  profile: GatewayAdminBrandVoiceProfile,
): BrandVoicePreviewRuntimeConfig {
  const entry = findBrandVoiceEntry(baseConfig);
  const pluginConfig = isRecord(entry?.config) ? entry.config : {};
  return {
    ...profile,
    failureMode: normalizeFailureMode(pluginConfig.failureMode),
    classifier: normalizeClassifierConfig(
      buildRuntimeClassifierConfig(profile.classifier),
    ),
  };
}

function buildVoiceBrief(
  profile: Omit<GatewayAdminBrandVoiceProfile, 'classifier'>,
): string {
  const sections: string[] = [];
  if (profile.voice) sections.push(`Brand voice: ${profile.voice}`);
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
  // Keep slash-pattern parsing aligned with plugins/brand-voice/src/config.js.
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
  profile: GatewayAdminBrandVoiceProfile,
): void {
  const invalidPatterns = listInvalidPatterns(profile.bannedPatterns);
  if (invalidPatterns.length === 0) return;
  throw new Error(
    `Invalid banned pattern${invalidPatterns.length === 1 ? '' : 's'}: ${invalidPatterns.join(', ')}`,
  );
}

function phraseAppears(text: string, phrase: string): boolean {
  return text.toLowerCase().includes(phrase.toLowerCase());
}

function scoreViolations(
  profile: Omit<GatewayAdminBrandVoiceProfile, 'classifier'>,
  sample: string,
): GatewayAdminBrandVoicePreviewViolation[] {
  const violations: GatewayAdminBrandVoicePreviewViolation[] = [];
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
  violations: GatewayAdminBrandVoicePreviewViolation[],
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
  profile: Omit<GatewayAdminBrandVoiceProfile, 'classifier'>,
  sample: string,
  violations: GatewayAdminBrandVoicePreviewViolation[],
): string {
  const sections = [
    `Brand voice brief:\n${buildVoiceBrief(profile) || '(none provided)'}`,
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
  client: BrandVoiceModelClientConfig,
  userPrompt: string,
  fallbackModel: string,
): Promise<{ content: string; model: string }> {
  if (client.provider === 'rules') {
    throw new Error('Brand voice classifier is in rules-only mode.');
  }
  const systemPrompt = [
    'You are a brand-voice compliance reviewer.',
    'You receive an assistant response and a brand voice brief.',
    'Decide whether the response is on-brand or off-brand.',
    'Reply with a single JSON object on one line: {"verdict":"on_brand"|"off_brand","reasons":[string],"severity":"low"|"medium"|"high"}',
    'Do not include any prose outside the JSON.',
  ].join(' ');
  const result = await callAuxiliaryModel({
    task: 'skills_hub',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    provider: client.provider === 'default' ? 'auto' : undefined,
    model: client.provider === 'default' ? fallbackModel : undefined,
    fallbackModel,
    fallbackEnableRag: false,
    maxTokens: 1024,
    temperature: 0,
    timeoutMs: 8000,
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
  if (verdict !== 'on_brand' && verdict !== 'off_brand') return null;
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
  if (verdict.verdict === 'on_brand') return PREVIEW_SCORE.max;
  if (verdict.severity === 'low') return 65;
  if (verdict.severity === 'medium') return 35;
  return 0;
}

async function runPreviewClassifier(
  config: BrandVoicePreviewRuntimeConfig,
  sample: string,
  violations: GatewayAdminBrandVoicePreviewViolation[],
): Promise<GatewayAdminBrandVoicePreviewClassifier> {
  const { classifier } = config;
  if (classifier.provider === 'rules') {
    return {
      provider: 'rules',
      status: 'rules_only',
      verdict: null,
      severity: null,
      reasons: [],
      message: 'Rules-only classifier; using deterministic rule score.',
      model: null,
    };
  }
  try {
    const result = await callClassifierModel(
      classifier,
      buildClassifierPrompt(config, sample, violations),
      getRuntimeConfig().hybridai.defaultModel,
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

function scoreBrandVoicePreview(
  config: BrandVoicePreviewRuntimeConfig,
  sample: string,
  classifier: GatewayAdminBrandVoicePreviewClassifier,
): GatewayAdminBrandVoicePreviewResponse {
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
    classifier.verdict === 'off_brand' ||
    failureModeScore === 0
      ? 'off_brand'
      : score >= PREVIEW_SCORE.onBrandMin
        ? 'on_brand'
        : score >= PREVIEW_SCORE.needsReviewMin
          ? 'needs_review'
          : 'off_brand';

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

export function getGatewayAdminBrandVoiceProfile(): GatewayAdminBrandVoiceProfileResponse {
  return buildProfileResponse(getRuntimeConfig());
}

export async function updateGatewayAdminBrandVoiceProfile(
  body: unknown,
): Promise<GatewayAdminBrandVoiceProfileUpdateResponse> {
  const previousConfig = getRuntimeConfig();
  const nextConfig = structuredClone(previousConfig);
  const previousProfile = readProfileFromConfig(previousConfig);
  const profile = normalizeProfile(isRecord(body) ? body.profile : body);
  assertValidBannedPatterns(profile);
  applyProfileToConfig(nextConfig, profile);

  const changed = !profilesEqual(previousProfile, profile);
  if (changed) {
    saveRuntimeConfig(nextConfig, {
      route: BRAND_VOICE_REVISION_ROUTE,
      source: 'admin-console',
    });
    const reloadResult = await reloadPluginRuntime();
    if (!reloadResult.ok) {
      try {
        saveRuntimeConfig(previousConfig, {
          route: `${BRAND_VOICE_REVISION_ROUTE}.rollback`,
          source: 'admin-console',
        });
        const rollbackReloadResult = await reloadPluginRuntime();
        if (!rollbackReloadResult.ok) {
          logger.warn(
            {
              reloadMessage: reloadResult.message,
              rollbackReloadMessage: rollbackReloadResult.message,
            },
            'Brand voice runtime rollback reload failed',
          );
        }
      } catch (error) {
        logger.error(
          { error, reloadMessage: reloadResult.message },
          'Brand voice runtime rollback failed',
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

export async function previewGatewayAdminBrandVoiceProfile(
  body: unknown,
): Promise<GatewayAdminBrandVoicePreviewResponse> {
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
      ? getGatewayAdminBrandVoiceProfile().profile
      : normalizeProfile(raw.profile);
  assertValidBannedPatterns(profile);
  const runtimeConfig = buildPreviewRuntimeConfig(getRuntimeConfig(), profile);
  const violations = scoreViolations(runtimeConfig, sample);
  const classifier = await runPreviewClassifier(
    runtimeConfig,
    sample,
    violations,
  );
  return scoreBrandVoicePreview(runtimeConfig, sample, classifier);
}
