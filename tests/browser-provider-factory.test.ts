import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';
import type { CamofoxModule } from '../src/browser/camofox-provider.js';
import type { LocalBrowserPlaywrightModule } from '../src/browser/local-provider.js';
import { createBrowserProvider } from '../src/browser/provider-factory.js';
import type { RuntimeBrowserConfig } from '../src/config/runtime-config.js';
import { DEFAULT_RUNTIME_CONFIG } from '../src/config/runtime-config.js';

let tempRoot = '';

function makeTempRoot(): string {
  tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-browser-factory-'),
  );
  return tempRoot;
}

function createMockPage() {
  return {
    evaluate: vi.fn(async (fn: () => unknown) => await fn()),
    screenshot: vi.fn(async () => Buffer.from('provider-png')),
    goto: vi.fn(async () => undefined),
    goBack: vi.fn(async () => undefined),
    goForward: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    click: vi.fn(async () => undefined),
    fill: vi.fn(async () => undefined),
    url: vi.fn(() => 'https://example.com/'),
    mouse: { wheel: vi.fn(async () => undefined) },
    waitForSelector: vi.fn(async () => undefined),
    locator: vi.fn(() => ({
      fill: vi.fn(async () => undefined),
      pressSequentially: vi.fn(async () => undefined),
      evaluate: vi.fn(async () => undefined),
    })),
  };
}

function createMockLocalPlaywright(): {
  playwright: LocalBrowserPlaywrightModule;
  launchPersistentContext: ReturnType<typeof vi.fn>;
} {
  const page = createMockPage();
  const context = {
    pages: vi.fn(() => [page]),
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => undefined),
  };
  const launchPersistentContext = vi.fn(async () => context);
  return {
    playwright: {
      chromium: {
        launchPersistentContext,
      },
    },
    launchPersistentContext,
  };
}

function createMockCamofox(): {
  camofox: CamofoxModule;
  Camoufox: ReturnType<typeof vi.fn>;
} {
  const page = createMockPage();
  const context = {
    pages: vi.fn(() => [page]),
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => undefined),
  };
  const Camoufox = vi.fn(async () => context);
  return {
    camofox: { Camoufox },
    Camoufox,
  };
}

function makeBrowserConfig(
  patch: Partial<RuntimeBrowserConfig>,
): RuntimeBrowserConfig {
  return {
    ...structuredClone(DEFAULT_RUNTIME_CONFIG.browser),
    ...patch,
    local: {
      ...DEFAULT_RUNTIME_CONFIG.browser.local,
      ...patch.local,
    },
    camofox: {
      ...DEFAULT_RUNTIME_CONFIG.browser.camofox,
      ...patch.camofox,
    },
    browserUseCloud: {
      ...DEFAULT_RUNTIME_CONFIG.browser.browserUseCloud,
      ...patch.browserUseCloud,
      browser: {
        ...DEFAULT_RUNTIME_CONFIG.browser.browserUseCloud.browser,
        ...patch.browserUseCloud?.browser,
      },
      pricing: {
        ...DEFAULT_RUNTIME_CONFIG.browser.browserUseCloud.pricing,
        ...patch.browserUseCloud?.pricing,
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = '';
  }
});

test('browser provider factory defaults to the local provider', async () => {
  const root = makeTempRoot();
  const mock = createMockLocalPlaywright();
  const provider = createBrowserProvider(
    makeBrowserConfig({
      provider: 'local',
      local: {
        profileRoot: path.join(root, 'profiles'),
        headed: true,
      },
    }),
    { localPlaywright: mock.playwright },
  );

  const session = await provider.launchSession({});
  await provider.closeSession(session);

  expect(mock.launchPersistentContext).toHaveBeenCalledWith(
    fs.realpathSync(path.join(root, 'profiles')),
    expect.objectContaining({ headless: false }),
  );
});

test('browser provider factory creates the configured camofox provider', async () => {
  const root = makeTempRoot();
  const mock = createMockCamofox();
  const provider = createBrowserProvider(
    makeBrowserConfig({
      provider: 'camofox',
      camofox: {
        profileRoot: path.join(root, 'profiles'),
        headed: false,
        launchOptions: {
          os: 'linux',
          block_webrtc: true,
        },
      },
    }),
    { camofox: mock.camofox },
  );

  const session = await provider.launchSession({ timeoutMs: 15_000 });
  await provider.closeSession(session);

  expect(mock.Camoufox).toHaveBeenCalledWith({
    os: 'linux',
    block_webrtc: true,
    user_data_dir: fs.realpathSync(path.join(root, 'profiles')),
    headless: true,
    timeout: 15_000,
  });
});

test('browser provider factory can select browser-use cloud', async () => {
  const provider = createBrowserProvider(
    makeBrowserConfig({
      provider: 'browser-use-cloud',
    }),
  );

  await expect(
    provider.launchSession({ profileDirHint: '/tmp/browser-profiles' }),
  ).rejects.toThrow(/does not accept local profileDirHint/u);
});
