import { expect, test } from 'vitest';

import { browserSessionConfigSignature } from '../src/browser/session-config-signature.js';
import { DEFAULT_RUNTIME_CONFIG } from '../src/config/runtime-config.js';

test('browser session config signature changes when private network access changes', () => {
  const base = {
    ...DEFAULT_RUNTIME_CONFIG.browser,
    provider: 'mac-cua' as const,
    allowPrivateNetwork: false,
  };

  expect(
    browserSessionConfigSignature({
      ...base,
      allowPrivateNetwork: true,
    }),
  ).not.toBe(browserSessionConfigSignature(base));
});

test('browser session config signature changes when native browser changes', () => {
  const base = {
    ...DEFAULT_RUNTIME_CONFIG.browser,
    provider: 'mac-cua' as const,
    macCua: {
      ...DEFAULT_RUNTIME_CONFIG.browser.macCua,
      browser: 'safari' as const,
    },
  };

  expect(
    browserSessionConfigSignature({
      ...base,
      macCua: {
        ...base.macCua,
        browser: 'chrome',
      },
    }),
  ).not.toBe(browserSessionConfigSignature(base));
});
