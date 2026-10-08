import { afterEach, expect, test } from 'vitest';

import {
  clearBrowserProviders,
  registerBrowserProvider,
} from '../src/browser/provider-factory.js';
import { browserSessionConfigSignature } from '../src/browser/session-config-signature.js';
import { DEFAULT_RUNTIME_CONFIG } from '../src/config/runtime-config.js';

afterEach(() => {
  clearBrowserProviders();
});

const base = {
  ...DEFAULT_RUNTIME_CONFIG.browser,
  provider: 'mac-cua',
  allowPrivateNetwork: false,
};

test('browser session config signature changes when private network access changes', () => {
  expect(
    browserSessionConfigSignature({ ...base, allowPrivateNetwork: true }),
  ).not.toBe(browserSessionConfigSignature(base));
});

// A plugin config edit reloads the plugin, which re-registers its provider;
// cached sessions must not keep running on the old settings.
test('browser session config signature changes when a provider re-registers', () => {
  const before = browserSessionConfigSignature(base);
  registerBrowserProvider({
    kind: 'mac-cua',
    create: () => ({
      launchSession: async () => {
        throw new Error('unused');
      },
      closeSession: async () => undefined,
    }),
  });

  expect(browserSessionConfigSignature(base)).not.toBe(before);
});
