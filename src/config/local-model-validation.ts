/**
 * A configured default cannot select a disabled named endpoint.
 * Unknown prefixes belong to provider resolution, which lets startup warn while
 * keeping configuration repair accessible. No endpoint or fallback is invented.
 */
import type { LocalEndpointConfig } from '../providers/local-types.js';

export class LocalModelConfigError extends Error {}

export function validateDefaultModelEndpoint(
  model: string,
  endpoints: LocalEndpointConfig[],
): void {
  const slash = model.indexOf('/');
  if (slash < 0) return;
  const prefix = model.slice(0, slash);
  const endpoint = endpoints.find((entry) => entry.name === prefix);
  if (endpoint && !endpoint.enabled) {
    throw new LocalModelConfigError(
      `hybridai.defaultModel selects disabled local endpoint "${prefix}". Enable it in local.endpoints or select another configured model.`,
    );
  }
}
