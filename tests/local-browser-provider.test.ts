import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { getBrowserProfileDir } from '../src/browser/browser-login.js';
import {
  type LocalBrowserPlaywrightModule,
  LocalBrowserProvider,
} from '../src/browser/local-provider.js';

let tempRoot = '';
const ORIGINAL_TEST_BROWSER_PASSWORD = process.env.TEST_BROWSER_PASSWORD;
const ORIGINAL_BROWSER_SHARED_PROFILE_DIR =
  process.env.BROWSER_SHARED_PROFILE_DIR;

function makeTempRoot(): string {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-browser-'));
  return tempRoot;
}

function createMockPlaywright(): {
  playwright: LocalBrowserPlaywrightModule;
  launchPersistentContext: ReturnType<typeof vi.fn>;
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
    mouse: { wheel: ReturnType<typeof vi.fn> };
    waitForSelector: ReturnType<typeof vi.fn>;
    locator: ReturnType<typeof vi.fn>;
  };
} {
  const page = {
    evaluate: vi.fn(async (fn: () => unknown) => await fn()),
    screenshot: vi.fn(async () => Buffer.from('mock-png')),
    goto: vi.fn(async () => undefined),
    goBack: vi.fn(async () => undefined),
    goForward: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    click: vi.fn(async () => undefined),
    fill: vi.fn(async () => undefined),
    mouse: { wheel: vi.fn(async () => undefined) },
    waitForSelector: vi.fn(async () => undefined),
    locator: vi.fn(() => ({
      evaluate: vi.fn(async () => undefined),
    })),
  };
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
  if (ORIGINAL_BROWSER_SHARED_PROFILE_DIR === undefined) {
    delete process.env.BROWSER_SHARED_PROFILE_DIR;
  } else {
    process.env.BROWSER_SHARED_PROFILE_DIR =
      ORIGINAL_BROWSER_SHARED_PROFILE_DIR;
  }
});

test('local browser provider launches a persistent profile and completes a smoke flow', async () => {
  const root = makeTempRoot();
  const dataDir = path.join(root, 'data');
  const profileDir = getBrowserProfileDir(dataDir);
  const mock = createMockPlaywright();
  const provider = new LocalBrowserProvider({
    dataDir,
    playwright: mock.playwright,
  });

  const session = await provider.launchSession({
    profileDirHint: profileDir,
    timeoutMs: 12_000,
  });
  await session.navigate('https://example.com/', {
    waitUntil: 'domcontentloaded',
    timeoutMs: 5_000,
  });
  const screenshot = await session.screenshot({ fullPage: true });
  await provider.closeSession(session);

  expect(mock.launchPersistentContext).toHaveBeenCalledWith(
    fs.realpathSync(profileDir),
    expect.objectContaining({
      headless: true,
      timeout: 12_000,
      args: expect.arrayContaining([
        '--password-store=basic',
        '--use-mock-keychain',
      ]),
    }),
  );
  expect(mock.page.goto).toHaveBeenCalledWith('https://example.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 5_000,
  });
  expect(screenshot).toEqual(Buffer.from('mock-png'));
  expect(mock.context.close).toHaveBeenCalledTimes(1);
});

test('local browser provider rejects profile hints outside the browser profile root', async () => {
  const root = makeTempRoot();
  const dataDir = path.join(root, 'data');
  const mock = createMockPlaywright();
  const provider = new LocalBrowserProvider({
    dataDir,
    playwright: mock.playwright,
  });

  await expect(
    provider.launchSession({
      profileDirHint: path.join(root, 'outside-browser-profiles'),
    }),
  ).rejects.toThrow(/must stay under/u);
  expect(mock.launchPersistentContext).not.toHaveBeenCalled();
});

test('local browser provider rejects unsafe navigation schemes', async () => {
  const root = makeTempRoot();
  const mock = createMockPlaywright();
  const provider = new LocalBrowserProvider({
    profileRoot: path.join(root, 'browser-profiles'),
    playwright: mock.playwright,
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

test('local browser provider reuses the shared private-network navigation guard', async () => {
  const root = makeTempRoot();
  const mock = createMockPlaywright();
  const provider = new LocalBrowserProvider({
    profileRoot: path.join(root, 'browser-profiles'),
    playwright: mock.playwright,
  });

  const session = await provider.launchSession({});

  await expect(session.navigate('http://127.0.0.1:3000/')).rejects.toThrow(
    /private or loopback host/u,
  );
  expect(mock.page.goto).not.toHaveBeenCalled();
});

test('local browser provider defaults to the shared container profile root when present', async () => {
  const root = makeTempRoot();
  const sharedProfileDir = path.join(root, 'container-browser-profiles');
  const mock = createMockPlaywright();
  process.env.BROWSER_SHARED_PROFILE_DIR = sharedProfileDir;
  const provider = new LocalBrowserProvider({
    playwright: mock.playwright,
  });

  await provider.launchSession({ headed: true });

  expect(mock.launchPersistentContext).toHaveBeenCalledWith(
    fs.realpathSync(sharedProfileDir),
    expect.objectContaining({
      headless: false,
    }),
  );
});

test('local browser provider resolves secret refs for fill without stringifying handles', async () => {
  const root = makeTempRoot();
  const mock = createMockPlaywright();
  const secretAudit = vi.fn();
  process.env.TEST_BROWSER_PASSWORD = 'test-password';
  const provider = new LocalBrowserProvider({
    profileRoot: path.join(root, 'browser-profiles'),
    playwright: mock.playwright,
    secretAudit,
  });

  const session = await provider.launchSession({});
  await session.fill('#password', {
    source: 'env',
    id: 'TEST_BROWSER_PASSWORD',
  });

  expect(mock.page.fill).toHaveBeenCalledWith('#password', 'test-password');
  expect(secretAudit).toHaveBeenCalledWith(
    expect.any(Object),
    'fill browser field #password',
  );
});
