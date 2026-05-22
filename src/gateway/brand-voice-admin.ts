import {
  getRuntimeConfig,
  type RuntimeConfig,
  type RuntimePluginConfigEntry,
  runtimeConfigPath,
  saveRuntimeConfig,
} from '../config/runtime-config.js';
import { listRuntimeConfigRevisions } from '../config/runtime-config-revisions.js';
import { logger } from '../logger.js';
import { reloadPluginRuntime } from './gateway-plugin-service.js';
import type {
  GatewayAdminBrandVoicePreviewResponse,
  GatewayAdminBrandVoicePreviewViolation,
  GatewayAdminBrandVoiceProfile,
  GatewayAdminBrandVoiceProfileResponse,
  GatewayAdminBrandVoiceProfileUpdateResponse,
  GatewayAdminBrandVoiceRevision,
} from './gateway-types.js';

const BRAND_VOICE_PLUGIN_ID = 'brand-voice';
const SUPPORTED_MODES = ['block', 'rewrite', 'flag'] as const;
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

function scoreBrandVoicePreview(
  profile: GatewayAdminBrandVoiceProfile,
  sample: string,
): GatewayAdminBrandVoicePreviewResponse {
  const violations = scoreViolations(profile, sample);
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
  score = Math.max(0, Math.min(PREVIEW_SCORE.max, score));
  const verdict =
    score >= PREVIEW_SCORE.onBrandMin
      ? 'on_brand'
      : score >= PREVIEW_SCORE.needsReviewMin
        ? 'needs_review'
        : 'off_brand';

  return {
    score,
    verdict,
    violations,
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

export function previewGatewayAdminBrandVoiceProfile(
  body: unknown,
): GatewayAdminBrandVoicePreviewResponse {
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
  return scoreBrandVoicePreview(profile, sample);
}
