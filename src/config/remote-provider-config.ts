/**
 * Remote-provider settings derive their keys and defaults from the provider catalog.
 * Every known OpenAI-compatible cloud provider keeps the same normalization rules.
 * Unlike credential resolution, this only shapes settings and migrates known URLs;
 * it neither loads secrets nor decides whether data may leave the host.
 */
import {
  OPENAI_COMPAT_REMOTE_PROVIDER_IDS,
  type OpenAICompatRemoteProviderId,
} from '../providers/provider-ids.js';
import { PROVIDER_META } from '../providers/provider-meta.js';
import { isRecord } from '../utils/type-guards.js';
import {
  normalizeBaseUrl,
  normalizeBoolean,
  normalizeStringArray,
} from './runtime-config-values.js';

interface RemoteProviderConfig {
  enabled: boolean;
  baseUrl: string;
  models: string[];
}
export type RemoteProviderConfigs = Record<
  OpenAICompatRemoteProviderId,
  RemoteProviderConfig
>;

export const DEFAULT_REMOTE_PROVIDER_CONFIG = Object.fromEntries(
  OPENAI_COMPAT_REMOTE_PROVIDER_IDS.map((id) => [
    id,
    {
      enabled: false,
      baseUrl: PROVIDER_META[id].defaultBaseUrl,
      models: [...PROVIDER_META[id].defaultModels],
    },
  ]),
) as RemoteProviderConfigs;

export function normalizeRemoteProviderConfigs(
  raw: Record<string, unknown>,
  defaults: RemoteProviderConfigs,
): RemoteProviderConfigs {
  return Object.fromEntries(
    OPENAI_COMPAT_REMOTE_PROVIDER_IDS.map((id) => {
      const section = isRecord(raw[id]) ? raw[id] : {};
      const fallback = defaults[id];
      const baseUrl = normalizeBaseUrl(section.baseUrl, fallback.baseUrl);
      const migrate = URL_MIGRATIONS[id];
      return [
        id,
        {
          enabled: normalizeBoolean(section.enabled, fallback.enabled),
          baseUrl: migrate ? migrate(baseUrl) : baseUrl,
          models: normalizeStringArray(section.models, fallback.models),
        },
      ];
    }),
  ) as RemoteProviderConfigs;
}

function migrateProviderBaseUrl(params: {
  provider: string;
  baseUrl: string;
  retired: ReadonlySet<string>;
  nextDefault: string;
}): string {
  if (params.retired.has(params.baseUrl)) {
    console.warn(
      `[runtime-config] migrating ${params.provider} baseUrl ${params.baseUrl} -> ${params.nextDefault}`,
    );
    return params.nextDefault;
  }
  return params.baseUrl;
}

const RETIRED_KILO_BASE_URLS = new Set<string>([
  'https://api.kilocode.ai/v1',
  'https://api.kilocode.ai',
  'http://api.kilocode.ai/v1',
  'http://api.kilocode.ai',
]);

function migrateKiloBaseUrl(baseUrl: string): string {
  return migrateProviderBaseUrl({
    provider: 'kilo',
    baseUrl,
    retired: RETIRED_KILO_BASE_URLS,
    nextDefault: DEFAULT_REMOTE_PROVIDER_CONFIG.kilo.baseUrl,
  });
}

const RETIRED_KIMI_BASE_URLS = new Set<string>([
  'https://api.kimi.com/coding/v1',
  'https://api.kimi.com/coding',
  'https://api.kimi.com/v1',
  'https://api.kimi.com',
  'http://api.kimi.com/coding/v1',
]);

function migrateKimiBaseUrl(baseUrl: string): string {
  return migrateProviderBaseUrl({
    provider: 'kimi',
    baseUrl,
    retired: RETIRED_KIMI_BASE_URLS,
    nextDefault: DEFAULT_REMOTE_PROVIDER_CONFIG.kimi.baseUrl,
  });
}

const URL_MIGRATIONS: Partial<
  Record<OpenAICompatRemoteProviderId, (url: string) => string>
> = {
  kilo: migrateKiloBaseUrl,
  kimi: migrateKimiBaseUrl,
};
