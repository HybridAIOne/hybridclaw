import {
  getRuntimeConfig,
  type RuntimeConfig,
  type RuntimePluginConfigEntry,
  runtimeConfigPath,
  saveRuntimeConfig,
} from '../config/runtime-config.js';
import { listRuntimeConfigRevisions } from '../config/runtime-config-revisions.js';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
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
    enabled: entry?.enabled !== false,
    mode: normalizeMode(pluginConfig.mode),
    voice: normalizeString(pluginConfig.voice),
    doList: normalizeStringArray(pluginConfig.doList),
    dontList: normalizeStringArray(pluginConfig.dontList),
    bannedPhrases: normalizeStringArray(pluginConfig.bannedPhrases),
    bannedPatterns: normalizeStringArray(pluginConfig.bannedPatterns),
    requirePhrases: normalizeStringArray(pluginConfig.requirePhrases),
  };
}

function normalizeProfile(value: unknown): GatewayAdminBrandVoiceProfile {
  const raw = isRecord(value) ? value : {};
  return {
    enabled: raw.enabled !== false,
    mode: normalizeMode(raw.mode),
    voice: normalizeString(raw.voice),
    doList: normalizeStringArray(raw.doList),
    dontList: normalizeStringArray(raw.dontList),
    bannedPhrases: normalizeStringArray(raw.bannedPhrases),
    bannedPatterns: normalizeStringArray(raw.bannedPatterns),
    requirePhrases: normalizeStringArray(raw.requirePhrases),
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
    configPath: runtimeConfigPath(),
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
  let score = 100;
  for (const violation of violations) {
    if (
      violation.kind === 'banned_phrase' ||
      violation.kind === 'banned_pattern'
    ) {
      score -= 30;
    } else {
      score -= 12;
    }
  }
  score = Math.max(0, Math.min(100, score));
  const verdict =
    score >= 90 ? 'on_brand' : score >= 70 ? 'needs_review' : 'off_brand';
  const reasons = violations.map((violation) => {
    if (violation.kind === 'banned_phrase') {
      return `Contains banned phrase "${violation.detail}".`;
    }
    if (violation.kind === 'banned_pattern') {
      return `Matches banned pattern ${violation.detail}.`;
    }
    return `Missing required phrase "${violation.detail}".`;
  });

  return {
    score,
    verdict,
    violations,
    reasons,
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
      saveRuntimeConfig(previousConfig, {
        route: `${BRAND_VOICE_REVISION_ROUTE}.rollback`,
        source: 'admin-console',
      });
      await reloadPluginRuntime();
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
  const profile =
    raw.profile === undefined
      ? getGatewayAdminBrandVoiceProfile().profile
      : normalizeProfile(raw.profile);
  assertValidBannedPatterns(profile);
  return scoreBrandVoicePreview(profile, sample);
}
