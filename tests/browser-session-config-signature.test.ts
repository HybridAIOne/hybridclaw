import { afterEach, expect, test, vi } from 'vitest';

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

function registerMacCua(fingerprint: string): void {
  registerBrowserProvider(
    {
      kind: 'mac-cua',
      create: () => ({
        launchSession: async () => {
          throw new Error('unused');
        },
        closeSession: async () => undefined,
      }),
    },
    fingerprint,
  );
}

// A plugin reload re-registers every provider. Only a changed plugin or
// plugin config may close the open sessions of its kind.
test.each([
  { label: 'its plugin config changed', next: 'mac-cua:{"browser":"safari"}', changes: true },
  { label: 'another plugin reloaded', next: 'mac-cua:{"browser":"chrome"}', changes: false },
])('browser session config signature on re-registration when $label', ({
  next,
  changes,
}) => {
  registerMacCua('mac-cua:{"browser":"chrome"}');
  const before = browserSessionConfigSignature(base);
  clearBrowserProviders();
  registerBrowserProvider(
    {
      kind: 'browserbase',
      create: () => ({ launchSession: vi.fn(), closeSession: vi.fn() }),
    },
    'browserbase:{}',
  );
  registerMacCua(next);

  expect(browserSessionConfigSignature(base) !== before).toBe(changes);
});
