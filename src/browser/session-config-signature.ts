import type { RuntimeBrowserConfig } from '../config/runtime-config.js';

export function browserSessionConfigSignature(
  config: RuntimeBrowserConfig,
): string {
  return JSON.stringify({
    provider: config.provider,
    allowPrivateNetwork: config.allowPrivateNetwork,
    local: config.local,
    camofox: config.camofox,
    browserUseCloud: config.browserUseCloud,
    managedCloud: config.managedCloud,
    macCua: config.macCua,
  });
}
