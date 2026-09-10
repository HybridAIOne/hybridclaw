/**
 * Configured model references must resolve before config is activated or saved.
 * Unlike provider discovery, this checks configuration only: a stopped local
 * service remains valid, and no endpoint, credential, or fallback is invented.
 */
import type { LocalEndpointConfig } from '../providers/local-types.js';
import { isRuntimeProviderId } from '../providers/provider-ids.js';

export class LocalModelConfigError extends Error {}

export function validateDefaultModelEndpoint(
  model: string,
  endpoints: LocalEndpointConfig[],
): void {
  const slash = model.indexOf('/');
  if (slash < 0) return;
  const prefix = model.slice(0, slash);
  const endpoint = endpoints.find((entry) => entry.name === prefix);
  if (endpoint) {
    if (!endpoint.enabled) {
      throw new LocalModelConfigError(
        `hybridai.defaultModel selects disabled local endpoint "${prefix}". Enable it in local.endpoints or select another configured model.`,
      );
    }
    return;
  }
  if (isRuntimeProviderId(prefix.toLowerCase())) return;
  throw new LocalModelConfigError(
    `hybridai.defaultModel references "${prefix}", but no matching local.endpoints entry or supported provider exists. Restore the endpoint in config.json or select another configured model. Use a HybridClaw build that supports the endpoint's backend.`,
  );
}
