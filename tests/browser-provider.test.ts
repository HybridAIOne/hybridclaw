import { Buffer } from 'node:buffer';
import { expect, test } from 'vitest';
import { getBrowserProfileDir } from '../src/browser/browser-login.js';
import type {
  BrowserActionName,
  BrowserProvider,
  BrowserSession,
  ClickOptions,
  NavigateOptions,
  NavigationOptions,
  ScreenshotOptions,
  ScrollOptions,
  SessionOptions,
  WaitOptions,
} from '../src/browser/provider.js';
import type { SecretRef } from '../src/security/secret-refs.js';

const requiredActionNames = [
  'click',
  'fill',
  'scroll',
  'wait_for_selector',
  'screenshot',
  'evaluate',
  'navigate',
  'back',
  'forward',
  'reload',
] as const satisfies readonly BrowserActionName[];

class MockBrowserSession implements BrowserSession {
  async evaluate<T>(fn: () => T | Promise<T>): Promise<T> {
    return await fn();
  }

  async screenshot(_opts?: ScreenshotOptions): Promise<Buffer> {
    return Buffer.from('mock-screenshot');
  }

  async navigate(_url: string, _opts?: NavigateOptions): Promise<void> {}

  async back(_opts?: NavigationOptions): Promise<void> {}

  async forward(_opts?: NavigationOptions): Promise<void> {}

  async reload(_opts?: NavigationOptions): Promise<void> {}

  async click(_selector: string, _opts?: ClickOptions): Promise<void> {}

  async fill(_selector: string, _value: SecretRef | string): Promise<void> {}

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
  expect(requiredActionNames).toEqual([
    'click',
    'fill',
    'scroll',
    'wait_for_selector',
    'screenshot',
    'evaluate',
    'navigate',
    'back',
    'forward',
    'reload',
  ]);
});

test('browser provider accepts browser-login profile directory hints', async () => {
  const provider = new MockBrowserProvider();
  const profileDirHint = getBrowserProfileDir('/tmp/hybridclaw-data');

  const session = await provider.launchSession({ profileDirHint });
  await session.fill('#password', { source: 'store', id: 'LOGIN_PASSWORD' });

  expect(provider.launchedProfileHints).toEqual([
    '/tmp/hybridclaw-data/browser-profiles',
  ]);
});
