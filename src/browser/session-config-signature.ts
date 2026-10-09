import type { RuntimeBrowserConfig } from '../config/runtime-config.js';
import { browserProviderFingerprint } from './provider-factory.js';

export function browserSessionConfigSignature(
  config: RuntimeBrowserConfig,
): string {
  return JSON.stringify({
    provider: config.provider,
    allowPrivateNetwork: config.allowPrivateNetwork,
    local: config.local,
    // Plugin providers read their own config, carried in the fingerprint.
    registration: browserProviderFingerprint(config.provider),
  });
}
