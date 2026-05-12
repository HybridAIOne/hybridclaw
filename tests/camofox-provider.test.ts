import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { getBrowserProfileDir } from '../src/browser/browser-login.js';
import {
  type CamofoxModule,
  CamofoxProvider,
} from '../src/browser/camofox-provider.js';

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
  const page = {
    evaluate: vi.fn(async (fn: () => unknown) => await fn()),
    screenshot: vi.fn(async () => Buffer.from('camofox-png')),
    goto: vi.fn(async () => undefined),
    goBack: vi.fn(async () => undefined),
    goForward: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    click: vi.fn(async () => undefined),
    fill: vi.fn(async () => undefined),
    url: vi.fn(() => 'https://login.datev.de/login'),
    mouse: { wheel: vi.fn(async () => undefined) },
    waitForSelector: vi.fn(async () => undefined),
    locator: vi.fn(() => ({
      fill: vi.fn(async () => undefined),
      pressSequentially: vi.fn(async () => undefined),
      evaluate: vi.fn(async () => undefined),
    })),
  };
  const context = {
    pages: vi.fn(() => [page]),
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => undefined),
  };
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
    timeout: 12_000,
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

test('camofox provider uses browser secret fill policy for SecretRef values', async () => {
  const root = makeTempRoot();
  const mock = createMockCamofox();
  const provider = new CamofoxProvider({
    profileRoot: path.join(root, 'browser-profiles'),
    camofox: mock.camofox,
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
