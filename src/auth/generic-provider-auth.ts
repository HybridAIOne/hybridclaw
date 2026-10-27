/**
 * Generic API-key providers — the OpenAI-compatible providers whose
 * `hybridclaw auth login|status|logout` flow is the same apart from these
 * fields: label, login defaults, secret key, and env var names.
 *
 * The CLI login/logout flows and the shared status lines (`auth-status.ts`)
 * read this table. Labels, keys, and defaults come from `PROVIDER_META`; only
 * the base-URL suffix the login flow enforces is defined here. NOT the
 * provider runtime (`openai-compat-remote.ts`), and NOT the target-name table
 * (`auth-targets.ts`).
 */
import type { OpenAICompatRemoteProviderId } from '../providers/provider-ids.js';
import { PROVIDER_META } from '../providers/provider-meta.js';

// OpenRouter, Mistral, and Hugging Face keep their own login flows.
type DedicatedLoginProviderId = 'openrouter' | 'mistral' | 'huggingface';

const BASE_URL_SUFFIX_BY_ID = {
  openai: '/v1',
  gemini: '/openai',
  deepseek: '/v1',
  xai: '/v1',
  zai: '/v4',
  kimi: '/v1',
  minimax: '/v1',
  dashscope: '/v1',
  xiaomi: '/v1',
  kilo: '/api/gateway',
} as const satisfies Record<
  'openai' | Exclude<OpenAICompatRemoteProviderId, DedicatedLoginProviderId>,
  string
>;

export type GenericProviderId = keyof typeof BASE_URL_SUFFIX_BY_ID;

export interface GenericProviderAuthDef {
  /** Provider ID used in CLI and config. */
  id: GenericProviderId;
  /** Human-readable label shown in status/error output. */
  label: string;
  /** Default model used when none is specified. */
  defaultModel: string;
  /** Default base URL for the API. */
  defaultBaseUrl: string;
  /** Regex to detect the URL path suffix that should be present. */
  baseUrlSuffixPattern: RegExp;
  /** Suffix appended to the base URL if the pattern doesn't match. */
  baseUrlSuffix: string;
  /** Canonical secret key name used for encrypted storage. */
  secretKey: string;
  /** All env var names checked for this provider (order matters). */
  envVarNames: readonly string[];
}

export const GENERIC_PROVIDER_AUTH_DEFS: readonly GenericProviderAuthDef[] = (
  Object.keys(BASE_URL_SUFFIX_BY_ID) as GenericProviderId[]
).map((id) => {
  const meta = PROVIDER_META[id];
  const baseUrlSuffix = BASE_URL_SUFFIX_BY_ID[id];
  return {
    id,
    label: meta.label,
    defaultModel: meta.defaultModels[0],
    defaultBaseUrl: meta.defaultBaseUrl,
    baseUrlSuffixPattern: new RegExp(`${baseUrlSuffix}$`, 'i'),
    baseUrlSuffix,
    secretKey: meta.secretKey,
    envVarNames: meta.envVars,
  };
});

const GENERIC_PROVIDER_BY_ID = new Map(
  GENERIC_PROVIDER_AUTH_DEFS.map((def) => [def.id, def]),
);

export function findGenericProviderDef(
  id: string,
): GenericProviderAuthDef | undefined {
  return GENERIC_PROVIDER_BY_ID.get(id as GenericProviderId);
}
