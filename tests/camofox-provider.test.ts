import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { getBrowserProfileDir } from '../src/browser/browser-login.js';
import {
  type CamofoxModule,
  CamofoxProvider,
} from '../src/browser/camofox-provider.js';
import {
  createMockBrowserContext,
  createMockBrowserPage,
} from './helpers/mock-browser.js';

let tempRoot = '';
const ORIGINAL_TEST_BROWSER_PASSWORD = process.env.TEST_BROWSER_PASSWORD;

function makeTempRoot(): string {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-camofox-'));
  return tempRoot;
}

function createMockCamofox(): {
  camofox: CamofoxModule;
  Camoufox: ReturnType<typeof vi.fn>;
  context: {
    pages: ReturnType<typeof vi.fn>;
    newPage: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  page: {
    evaluate: ReturnType<typeof vi.fn>;
    screenshot: ReturnType<typeof vi.fn>;
    goto: ReturnType<typeof vi.fn>;
    goBack: ReturnType<typeof vi.fn>;
    goForward: ReturnType<typeof vi.fn>;
    reload: ReturnType<typeof vi.fn>;
    click: ReturnType<typeof vi.fn>;
    fill: ReturnType<typeof vi.fn>;
    url: ReturnType<typeof vi.fn>;
    mouse: { wheel: ReturnType<typeof vi.fn> };
    waitForSelector: ReturnType<typeof vi.fn>;
    locator: ReturnType<typeof vi.fn>;
  };
} {
  const page = createMockBrowserPage({ screenshot: 'camofox-png' });
  const context = createMockBrowserContext(page);
  const Camoufox = vi.fn(async () => context);
  return {
    camofox: { Camoufox },
    Camoufox,
    context,
    page,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = '';
  }
  if (ORIGINAL_TEST_BROWSER_PASSWORD === undefined) {
    delete process.env.TEST_BROWSER_PASSWORD;
  } else {
    process.env.TEST_BROWSER_PASSWORD = ORIGINAL_TEST_BROWSER_PASSWORD;
  }
});

test('camofox provider launches a persistent profile with stealth launch options', async () => {
  const root = makeTempRoot();
  const dataDir = path.join(root, 'data');
  const profileDir = getBrowserProfileDir(dataDir);
  const mock = createMockCamofox();
  const provider = new CamofoxProvider({
    dataDir,
    camofox: mock.camofox,
    stealthPolicy: () => undefined,
    launchOptions: {
      os: 'linux',
      block_webrtc: true,
      humanize: true,
      window: [1366, 768],
    },
  });

  const session = await provider.launchSession({
    profileDirHint: profileDir,
    headed: true,
    timeoutMs: 12_000,
  });
  await session.navigate('https://example.com/', {
    waitUntil: 'domcontentloaded',
    timeoutMs: 5_000,
  });
  const screenshot = await session.screenshot({ fullPage: true });
  await provider.closeSession(session);

  expect(mock.Camoufox).toHaveBeenCalledWith({
    os: 'linux',
    block_webrtc: true,
    humanize: true,
    window: [1366, 768],
    user_data_dir: fs.realpathSync(profileDir),
    headless: false,
  });
  expect(mock.page.goto).toHaveBeenCalledWith('https://example.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 5_000,
  });
  expect(screenshot).toEqual(Buffer.from('camofox-png'));
  expect(mock.context.close).toHaveBeenCalledTimes(1);
});

test('camofox provider rejects profile hints outside the browser profile root', async () => {
  const root = makeTempRoot();
  const dataDir = path.join(root, 'data');
  const mock = createMockCamofox();
  const provider = new CamofoxProvider({
    dataDir,
    camofox: mock.camofox,
    stealthPolicy: () => undefined,
  });

  await expect(
    provider.launchSession({
      profileDirHint: path.join(root, 'outside-browser-profiles'),
    }),
  ).rejects.toThrow(/must stay under/u);
  expect(mock.Camoufox).not.toHaveBeenCalled();
});

test('camofox provider rejects unsafe navigation schemes', async () => {
  const root = makeTempRoot();
  const mock = createMockCamofox();
  const provider = new CamofoxProvider({
    profileRoot: path.join(root, 'browser-profiles'),
    camofox: mock.camofox,
    stealthPolicy: () => undefined,
  });

  const session = await provider.launchSession({});

  await expect(session.navigate('file:///etc/passwd')).rejects.toThrow(
    /Unsupported URL protocol/u,
  );
  await expect(session.navigate('javascript:alert(1)')).rejects.toThrow(
    /Unsupported URL protocol/u,
  );
  await session.navigate('about:blank');

  expect(mock.page.goto).toHaveBeenCalledTimes(1);
  expect(mock.page.goto).toHaveBeenCalledWith('about:blank', undefined);
});

test('camofox provider enforces per-host stealth policy before navigation', async () => {
  const root = makeTempRoot();
  const mock = createMockCamofox();
  const stealthPolicy = vi.fn(({ host }: { host: string }) => {
    if (host !== 'allowed.example') {
      throw new Error(`stealth denied for ${host}`);
    }
  });
  const provider = new CamofoxProvider({
    profileRoot: path.join(root, 'browser-profiles'),
    camofox: mock.camofox,
    stealthPolicy,
  });

  const session = await provider.launchSession({});
  await expect(session.navigate('https://blocked.example/')).rejects.toThrow(
    /stealth denied for blocked\.example/u,
  );
  await session.navigate('https://allowed.example/');

  expect(stealthPolicy).toHaveBeenCalledWith({
    host: 'blocked.example',
    metering: undefined,
  });
  expect(stealthPolicy).toHaveBeenCalledWith({
    host: 'allowed.example',
    metering: undefined,
  });
  expect(mock.page.goto).toHaveBeenCalledTimes(1);
  expect(mock.page.goto).toHaveBeenCalledWith(
    'https://allowed.example/',
    undefined,
  );
});

test('camofox provider uses browser secret fill policy for SecretRef values', async () => {
  const root = makeTempRoot();
  const mock = createMockCamofox();
  const provider = new CamofoxProvider({
    profileRoot: path.join(root, 'browser-profiles'),
    camofox: mock.camofox,
    stealthPolicy: () => undefined,
  });

  const session = await provider.launchSession({});
  await expect(
    session.fill('#password', {
      source: 'env',
      id: 'TEST_BROWSER_PASSWORD',
    }),
  ).rejects.toThrow(/SessionOptions\.metering\.skillName/u);

  expect(mock.page.fill).not.toHaveBeenCalled();
  expect(mock.page.locator).not.toHaveBeenCalled();
});

test('camofox provider enforces launch timeout without forwarding it to Camoufox', async () => {
  vi.useFakeTimers();
  try {
    const root = makeTempRoot();
    const context = {
      pages: vi.fn(() => []),
      newPage: vi.fn(async () => createMockCamofox().page),
      close: vi.fn(async () => undefined),
    };
    let resolveLaunch: ((value: typeof context) => void) | undefined;
    const Camoufox = vi.fn(
      () =>
        new Promise<typeof context>((resolve) => {
          resolveLaunch = resolve;
        }),
    );
    const provider = new CamofoxProvider({
      profileRoot: path.join(root, 'browser-profiles'),
      camofox: { Camoufox },
      stealthPolicy: () => undefined,
    });

    const launch = provider.launchSession({ timeoutMs: 25 });
    launch.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(25);

    await expect(launch).rejects.toThrow(/timed out after 25ms/u);
    expect(Camoufox).toHaveBeenCalledWith(
      expect.not.objectContaining({ timeout: 25 }),
    );

    resolveLaunch?.(context);
    await vi.runAllTimersAsync();
    await Promise.resolve();
    expect(context.close).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});
