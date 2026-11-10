import type { RuntimeProviderId } from '@hybridclaw/contracts/provider-ids';
import { inferProviderFromModelPrefix } from '@hybridclaw/shared/provider-ids';

export * from '@hybridclaw/contracts/provider-ids';
export * from '@hybridclaw/shared/provider-ids';

export function resolveRuntimeProviderContext(
  provider: RuntimeProviderId | undefined,
  model: string,
): RuntimeProviderId {
  return provider || inferProviderFromModelPrefix(model) || 'hybridai';
}
