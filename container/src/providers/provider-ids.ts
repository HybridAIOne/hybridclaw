import {
  inferProviderFromModelPrefix,
  type RuntimeProviderId,
} from '#shared/provider-ids.js';

export * from '#shared/provider-ids.js';

export function resolveRuntimeProviderContext(
  provider: RuntimeProviderId | undefined,
  model: string,
): RuntimeProviderId {
  return provider || inferProviderFromModelPrefix(model) || 'hybridai';
}
