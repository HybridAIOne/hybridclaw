import {
  getRuntimeConfig,
  type RuntimeConfig,
  type RuntimePluginConfigEntry,
  runtimeConfigPath,
  saveRuntimeConfig,
} from '../config/runtime-config.js';
import { listRuntimeConfigRevisions } from '../config/runtime-config-revisions.js';
import { logger } from '../logger.js';
import { readStoredRuntimeSecret } from '../security/runtime-secrets.js';
import { reloadPluginRuntime } from './gateway-plugin-service.js';
import type {
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
  'none',
  'anthropic',
  'openai',
  'openai-compat',
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
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  timeoutMs: number;
  maxRetries: number;
}

interface BrandVoicePreviewRuntimeConfig extends GatewayAdminBrandVoiceProfile {
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
    : 'none';
}

function normalizeFailureMode(value: unknown): BrandVoiceFailureMode {
  const normalized = normalizeString(value).toLowerCase();
  return SUPPORTED_FAILURE_MODES.includes(normalized as BrandVoiceFailureMode)
    ? (normalized as BrandVoiceFailureMode)
    : 'allow';
}

function normalizeNumber(
  value: unknown,
  fallback: number,
  range: { min: number; max: number },
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(range.min, Math.min(range.max, value));
}

function defaultApiKeyEnv(provider: BrandVoiceClassifierProvider): string {
  if (provider === 'anthropic') return 'ANTHROPIC_API_KEY';
  if (provider === 'openai') return 'OPENAI_API_KEY';
  return 'BRAND_VOICE_API_KEY';
}

function defaultBaseUrl(provider: BrandVoiceClassifierProvider): string {
  if (provider === 'anthropic') return 'https://api.anthropic.com';
  if (provider === 'openai') return 'https://api.openai.com/v1';
  return '';
}

function normalizeClassifierConfig(
  value: unknown,
): BrandVoiceModelClientConfig {
  const raw = isRecord(value) ? value : {};
  const provider = normalizeClassifierProvider(raw.provider);
  if (provider === 'none') {
    return {
      provider,
      timeoutMs: 8000,
      maxRetries: 1,
    };
  }
  const model = normalizeString(raw.model);
  if (!model) {
    throw new Error(
      `Brand voice classifier provider is "${provider}" but classifier.model is empty.`,
    );
  }
  return {
    provider,
    model,
    baseUrl: normalizeString(raw.baseUrl) || defaultBaseUrl(provider),
    apiKeyEnv: normalizeString(raw.apiKeyEnv) || defaultApiKeyEnv(provider),
    timeoutMs: normalizeNumber(raw.timeoutMs, 8000, {
      min: 1000,
      max: 60_000,
    }),
    maxRetries: normalizeNumber(raw.maxRetries, 1, { min: 0, max: 3 }),
  };
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
  entry.enabled = profile.enabled;
  entry.config = {
    ...entry.config,
    mode: profile.mode,
    voice: profile.voice,
    doList: profile.doList,
    dontList: profile.dontList,
    bannedPhrases: profile.bannedPhrases,
    bannedPatterns: profile.bannedPatterns,
    requirePhrases: profile.requirePhrases,
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
    classifier: normalizeClassifierConfig(pluginConfig.classifier),
  };
}

function buildVoiceBrief(profile: GatewayAdminBrandVoiceProfile): string {
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
  profile: GatewayAdminBrandVoiceProfile,
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
  profile: GatewayAdminBrandVoiceProfile,
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

function getCredentialValue(name: string | undefined): string {
  const key = normalizeString(name);
  if (!key) return '';
  const envValue = process.env[key];
  if (typeof envValue === 'string' && envValue.trim()) {
    return envValue.trim();
  }
  return readStoredRuntimeSecret(key)?.trim() || '';
}

async function fetchJsonWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<unknown> {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, { ...init, signal });
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(
      `brand-voice classifier returned ${response.status}: ${bodyText.slice(0, 400)}`,
    );
  }
  if (!bodyText) return {};
  try {
    return JSON.parse(bodyText) as unknown;
  } catch (error) {
    throw new Error(
      `brand-voice classifier returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function extractAnthropicText(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.content)) return '';
  return payload.content
    .map((block) =>
      isRecord(block) && typeof block.text === 'string' ? block.text : '',
    )
    .filter(Boolean)
    .join('\n')
    .trim();
}

function extractOpenAIText(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return '';
  const choice = payload.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) return '';
  const content = choice.message.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      isRecord(part) && typeof part.text === 'string' ? part.text : '',
    )
    .filter(Boolean)
    .join('\n')
    .trim();
}

async function callClassifierModel(
  client: BrandVoiceModelClientConfig,
  userPrompt: string,
): Promise<string> {
  if (client.provider === 'none') {
    throw new Error('Brand voice classifier is not configured.');
  }
  const apiKey = getCredentialValue(client.apiKeyEnv);
  if (client.provider !== 'openai-compat' && !apiKey) {
    throw new Error(
      `Missing API key in ${client.apiKeyEnv} for brand voice classifier.`,
    );
  }

  const systemPrompt = [
    'You are a brand-voice compliance reviewer.',
    'You receive an assistant response and a brand voice brief.',
    'Decide whether the response is on-brand or off-brand.',
    'Reply with a single JSON object on one line: {"verdict":"on_brand"|"off_brand","reasons":[string],"severity":"low"|"medium"|"high"}',
    'Do not include any prose outside the JSON.',
  ].join(' ');
  const attempts = Math.max(1, client.maxRetries + 1);
  let lastError: unknown = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (client.provider === 'anthropic') {
        const payload = await fetchJsonWithTimeout(
          `${(client.baseUrl || defaultBaseUrl(client.provider)).replace(/\/+$/, '')}/v1/messages`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: client.model,
              max_tokens: 1024,
              system: systemPrompt,
              messages: [{ role: 'user', content: userPrompt }],
            }),
          },
          client.timeoutMs,
        );
        return extractAnthropicText(payload);
      }

      const url = client.baseUrl
        ? `${client.baseUrl.replace(/\/+$/, '')}/chat/completions`
        : 'https://api.openai.com/v1/chat/completions';
      const payload = await fetchJsonWithTimeout(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: client.model,
            max_tokens: 1024,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
          }),
        },
        client.timeoutMs,
      );
      return extractOpenAIText(payload);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error('Brand voice classifier call failed.');
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
  if (classifier.provider === 'none') {
    return {
      provider: 'none',
      status: 'not_configured',
      verdict: null,
      severity: null,
      reasons: [],
      message: 'Classifier provider is not configured; showing rules score.',
    };
  }
  try {
    const raw = await callClassifierModel(
      classifier,
      buildClassifierPrompt(config, sample, violations),
    );
    const verdict = parseClassifierVerdict(raw);
    if (!verdict) {
      return {
        provider: classifier.provider,
        status: 'unparseable',
        verdict: null,
        severity: null,
        reasons: [],
        message: 'Classifier returned a response that could not be parsed.',
      };
    }
    return {
      provider: classifier.provider,
      status: 'evaluated',
      verdict: verdict.verdict,
      severity: verdict.severity,
      reasons: verdict.reasons,
      message: null,
    };
  } catch (error) {
    return {
      provider: classifier.provider,
      status: 'unavailable',
      verdict: null,
      severity: null,
      reasons: [],
      message: error instanceof Error ? error.message : String(error),
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
