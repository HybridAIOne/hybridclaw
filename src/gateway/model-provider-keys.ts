/**
 * Gateway provider keys — the runtime provider ids as `providerHealth`, the
 * model catalog, `/model list`, and the console name them. They differ only in
 * `codex` for `openai-codex`; convert here, never with a local ternary.
 */
import {
  RUNTIME_PROVIDER_IDS,
  type RuntimeProviderId,
} from '../providers/provider-ids.js';

export type GatewayModelProviderKey =
  | Exclude<RuntimeProviderId, 'openai-codex'>
  | 'codex';

/** The key `providerHealth`, catalog entries, and `/model list` use for a provider. */
export function toGatewayModelProviderKey(
  id: RuntimeProviderId,
): GatewayModelProviderKey {
  return id === 'openai-codex' ? 'codex' : id;
}

export function fromGatewayModelProviderKey(
  key: GatewayModelProviderKey,
): RuntimeProviderId {
  return key === 'codex' ? 'openai-codex' : key;
}

export const GATEWAY_MODEL_PROVIDER_KEYS: readonly GatewayModelProviderKey[] =
  RUNTIME_PROVIDER_IDS.map(toGatewayModelProviderKey);
