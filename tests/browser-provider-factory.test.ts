import fs from 'node:fs';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';
import type { LocalBrowserPlaywrightModule } from '../src/browser/local-provider.js';
import {
  type BrowserProviderRegistration,
  clearBrowserProviders,
  createBrowserProvider,
  registerBrowserProvider,
} from '../src/browser/provider-factory.js';
import type { BrowserProviderHost } from '../src/browser/provider-host.js';
import type { RuntimeBrowserConfig } from '../src/config/runtime-config.js';
import { DEFAULT_RUNTIME_CONFIG } from '../src/config/runtime-config.js';
import {
  createMockBrowserContext,
  createMockBrowserPage,
} from './helpers/mock-browser.js';
import { useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir();

afterEach(() => {
  clearBrowserProviders();
  vi.restoreAllMocks();
});

function browserConfig(
  patch: Partial<RuntimeBrowserConfig>,
): RuntimeBrowserConfig {
  return { ...structuredClone(DEFAULT_RUNTIME_CONFIG.browser), ...patch };
}

test('builds the local provider for browser.provider local', async () => {
  const root = makeTempDir('hybridclaw-browser-factory-');
  const page = createMockBrowserPage({ url: 'https://example.com/' });
  const launchPersistentContext = vi.fn(async () =>
    createMockBrowserContext(page),
  );
  const provider = createBrowserProvider(
    browserConfig({
      provider: 'local',
      local: { profileRoot: path.join(root, 'profiles'), headed: true },
    }),
    {
      localPlaywright: {
        chromium: { launchPersistentContext },
      } as unknown as LocalBrowserPlaywrightModule,
    },
  );

  const session = await provider.launchSession({});
  await provider.closeSession(session);

  expect(launchPersistentContext).toHaveBeenCalledWith(
    fs.realpathSync(path.join(root, 'profiles')),
    expect.objectContaining({ headless: false }),
  );
});

test.each([
  'browserbase',
  'camofox',
  'managed-cloud',
  'browser-use-cloud',
  'mac-cua',
])('fails for an unregistered %s provider instead of falling back to local', (provider) => {
  expect(() => createBrowserProvider(browserConfig({ provider }))).toThrow(
    new RegExp(
      `Browser provider "${provider}" is not available.*hybridclaw plugin install ${provider}`,
      'u',
    ),
  );
});

test('builds a plugin-registered provider with the gateway host', () => {
  let received: BrowserProviderHost | undefined;
  const built = {
    launchSession: vi.fn(),
    closeSession: vi.fn(),
  };
  registerBrowserProvider(
    {
      kind: 'browserbase',
      create(host) {
        received = host;
        return built;
      },
    },
    'browserbase:{}',
  );

  const provider = createBrowserProvider(
    browserConfig({ provider: 'browserbase', allowPrivateNetwork: true }),
  );

  expect(provider).toBe(built);
  expect(received?.allowPrivateNetwork).toBe(true);
  expect(typeof received?.navigation.assertUrl).toBe('function');
  expect(typeof received?.audit.record).toBe('function');
});

test.each<[string, Partial<BrowserProviderRegistration>, RegExp]>([
  ['the built-in local kind', { kind: 'local' }, /already registered/u],
  ['an empty kind', { kind: '' }, /non-empty lowercase/u],
  ['a mixed-case kind', { kind: 'Mac-CUA' }, /non-empty lowercase/u],
  [
    'a registration without create',
    { kind: 'browserbase', create: undefined },
    /missing `create`/u,
  ],
])('rejects registering %s', (_label, patch, error) => {
  expect(() =>
    registerBrowserProvider(
      {
        kind: 'browserbase',
        create: () => ({ launchSession: vi.fn(), closeSession: vi.fn() }),
        ...patch,
      } as BrowserProviderRegistration,
      'browserbase:{}',
    ),
  ).toThrow(error);
});

test('rejects a second registration of the same kind', () => {
  const registration: BrowserProviderRegistration = {
    kind: 'browserbase',
    create: () => ({ launchSession: vi.fn(), closeSession: vi.fn() }),
  };
  registerBrowserProvider(registration, 'browserbase:{}');
  expect(() => registerBrowserProvider(registration, 'browserbase:{}')).toThrow(
    /already registered/u,
  );
  clearBrowserProviders();

  expect(() =>
    createBrowserProvider(browserConfig({ provider: 'browserbase' })),
  ).toThrow(/not available/u);
});

test('names the load error of a plugin that failed instead of asking to install it', () => {
  const create = () =>
    createBrowserProvider(browserConfig({ provider: 'camofox' }), {
      pluginLoadError: 'launchOptions.timeout is managed by HybridClaw',
    });

  expect(create).toThrow(/failed to load: launchOptions\.timeout/u);
  expect(create).not.toThrow(/plugin install/u);
});
