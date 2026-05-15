import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';
import type { CamofoxModule } from '../src/browser/camofox-provider.js';
import type { LocalBrowserPlaywrightModule } from '../src/browser/local-provider.js';
import type { MacCuaDriver } from '../src/browser/mac-cua-provider.js';
import { createBrowserProvider } from '../src/browser/provider-factory.js';
import type { RuntimeBrowserConfig } from '../src/config/runtime-config.js';
import { DEFAULT_RUNTIME_CONFIG } from '../src/config/runtime-config.js';
import {
  createMockBrowserContext,
  createMockBrowserPage,
} from './helpers/mock-browser.js';

let tempRoot = '';

function makeTempRoot(): string {
  tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-browser-factory-'),
  );
  return tempRoot;
}

function createMockLocalPlaywright(): {
  playwright: LocalBrowserPlaywrightModule;
  launchPersistentContext: ReturnType<typeof vi.fn>;
} {
  const page = createMockBrowserPage({
    screenshot: 'provider-png',
    url: 'https://example.com/',
  });
  const context = createMockBrowserContext(page);
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
  const page = createMockBrowserPage({
    screenshot: 'provider-png',
    url: 'https://example.com/',
  });
  const context = createMockBrowserContext(page);
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
    macCua: {
      ...DEFAULT_RUNTIME_CONFIG.browser.macCua,
      ...patch.macCua,
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

test('browser provider factory can select mac-cua', async () => {
  const driver: MacCuaDriver = {
    startBrowserSession: vi.fn(async () => ({ sessionId: 'mac-cua-session' })),
    stopBrowserSession: vi.fn(async () => undefined),
    keyChord: vi.fn(async () => undefined),
    pressKey: vi.fn(async () => undefined),
    typeTextChars: vi.fn(async () => undefined),
    click: vi.fn(async () => undefined),
    setValue: vi.fn(async () => undefined),
    scroll: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => ({
      dataBase64: Buffer.from('factory-cua').toString('base64'),
    })),
    waitForElement: vi.fn(async () => undefined),
    getCurrentUrl: vi.fn(async () => 'https://example.com/'),
  };
  const provider = createBrowserProvider(
    makeBrowserConfig({
      provider: 'mac-cua',
      macCua: {
        browser: 'brave',
        driverCommand: '',
        driverArgs: [],
        screenshotMode: 'vision',
      },
    }),
    { macCuaDriver: driver },
  );

  const session = await provider.launchSession({});
  await session.screenshot();
  await provider.closeSession(session);

  expect(driver.startBrowserSession).toHaveBeenCalledWith({
    bundleId: 'com.brave.Browser',
    backgroundSafe: true,
  });
  expect(driver.screenshot).toHaveBeenCalledWith('mac-cua-session', {
    mode: 'vision',
  });
});
