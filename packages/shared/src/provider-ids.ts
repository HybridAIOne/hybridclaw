/**
 * Provider id runtime: the derived id lists, membership guards, and the
 * `${id}/` model-prefix helpers. The id lists themselves are wire data and
 * live in `@hybridclaw/contracts/provider-ids`; everything here derives from
 * them. Labels, secret keys, and default URLs live in
 * `src/providers/provider-meta.ts`, not here.
 */
import {
  LOCAL_BACKEND_IDS,
  type LocalBackendType,
  OPENAI_COMPAT_REMOTE_PROVIDER_IDS,
  type OpenAICompatRemoteProviderId,
  RUNTIME_PROVIDER_IDS,
  type RuntimeProviderId,
} from '@hybridclaw/contracts/provider-ids';

export type OpenAICompatProviderId =
  | OpenAICompatRemoteProviderId
  | Exclude<LocalBackendType, 'ollama'>;
export type NonHybridProviderId = Exclude<RuntimeProviderId, 'hybridai'>;

export const OPENAI_COMPAT_PROVIDER_IDS: readonly OpenAICompatProviderId[] = [
  ...OPENAI_COMPAT_REMOTE_PROVIDER_IDS,
  ...LOCAL_BACKEND_IDS.filter(
    (id): id is Exclude<LocalBackendType, 'ollama'> => id !== 'ollama',
  ),
];

export const NON_HYBRID_PROVIDER_IDS: readonly NonHybridProviderId[] =
  RUNTIME_PROVIDER_IDS.filter(
    (id): id is NonHybridProviderId => id !== 'hybridai',
  );

const LOCAL_BACKEND_ID_SET = new Set<string>(LOCAL_BACKEND_IDS);
const RUNTIME_PROVIDER_ID_SET = new Set<string>(RUNTIME_PROVIDER_IDS);
const OPENAI_COMPAT_PROVIDER_ID_SET = new Set<string>(
  OPENAI_COMPAT_PROVIDER_IDS,
);
const OPENAI_COMPAT_REMOTE_PROVIDER_ID_SET = new Set<string>(
  OPENAI_COMPAT_REMOTE_PROVIDER_IDS,
);

export function isLocalBackendType(value: string): value is LocalBackendType {
  return LOCAL_BACKEND_ID_SET.has(value);
}

export function isRuntimeProviderId(
  value: unknown,
): value is RuntimeProviderId {
  return typeof value === 'string' && RUNTIME_PROVIDER_ID_SET.has(value);
}

export function isOpenAICompatProviderId(
  value: unknown,
): value is OpenAICompatProviderId {
  return typeof value === 'string' && OPENAI_COMPAT_PROVIDER_ID_SET.has(value);
}

export function isOpenAICompatRemoteProviderId(
  value: unknown,
): value is OpenAICompatRemoteProviderId {
  return (
    typeof value === 'string' && OPENAI_COMPAT_REMOTE_PROVIDER_ID_SET.has(value)
  );
}

export function providerModelPrefix<Id extends string>(id: Id): `${Id}/` {
  return `${id}/` as `${Id}/`;
}

/** The non-HybridAI provider a model id's `${id}/` prefix names, if any. */
export function inferProviderFromModelPrefix(
  model: string,
): NonHybridProviderId | undefined {
  const normalized = String(model || '')
    .trim()
    .toLowerCase();
  if (!normalized) return undefined;
  return NON_HYBRID_PROVIDER_IDS.find((id) =>
    normalized.startsWith(providerModelPrefix(id)),
  );
}
