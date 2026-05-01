import { Buffer } from 'node:buffer';
import { expect, test } from 'vitest';
import { getBrowserProfileDir } from '../src/browser/browser-login.js';
import type {
  BrowserActionName,
  BrowserProvider,
  BrowserSession,
  ClickOptions,
  HistoryNavigationOptions,
  NavigateOptions,
  ScreenshotOptions,
  ScrollOptions,
  SessionOptions,
  WaitOptions,
} from '../src/browser/provider.js';
import type { SecretInput } from '../src/security/secret-refs.js';

const requiredActionNames = {
  click: true,
  fill: true,
  scroll: true,
  wait_for_selector: true,
  screenshot: true,
  evaluate: true,
  navigate: true,
  back: true,
  forward: true,
  reload: true,
} satisfies Record<BrowserActionName, true>;

class MockBrowserSession implements BrowserSession {
  async evaluate<T>(fn: () => T | Promise<T>): Promise<T> {
    return await fn();
  }

  async screenshot(_opts?: ScreenshotOptions): Promise<Buffer> {
    return Buffer.from('mock-screenshot');
  }

  async navigate(_url: string, _opts?: NavigateOptions): Promise<void> {}

  async back(_opts?: HistoryNavigationOptions): Promise<void> {}

  async forward(_opts?: HistoryNavigationOptions): Promise<void> {}

  async reload(_opts?: HistoryNavigationOptions): Promise<void> {}

  async click(_selector: string, _opts?: ClickOptions): Promise<void> {}

  async fill(_selector: string, _value: SecretInput): Promise<void> {}

  async scroll(_opts: ScrollOptions): Promise<void> {}

  async waitForSelector(
    _selector: string,
    _opts?: WaitOptions,
  ): Promise<void> {}
}

class MockBrowserProvider implements BrowserProvider {
  readonly launchedProfileHints: string[] = [];

  async launchSession(opts: SessionOptions): Promise<BrowserSession> {
    if (opts.profileDirHint)
      this.launchedProfileHints.push(opts.profileDirHint);
    return new MockBrowserSession();
  }

  async closeSession(_session: BrowserSession): Promise<void> {}
}

test('browser provider contract covers the required action vocabulary', () => {
  expect(Object.keys(requiredActionNames).sort()).toEqual([
    'back',
    'click',
    'evaluate',
    'fill',
    'forward',
    'navigate',
    'reload',
    'screenshot',
    'scroll',
    'wait_for_selector',
  ]);
});

test('browser provider accepts browser-login profile directory hints', async () => {
  const provider = new MockBrowserProvider();
  const profileDirHint = getBrowserProfileDir('/tmp/hybridclaw-data');

  const session = await provider.launchSession({ profileDirHint });
  await session.fill('#password', { source: 'store', id: 'LOGIN_PASSWORD' });
  await session.scroll({ direction: 'down' });

  expect(provider.launchedProfileHints).toEqual([
    '/tmp/hybridclaw-data/browser-profiles',
  ]);
});
