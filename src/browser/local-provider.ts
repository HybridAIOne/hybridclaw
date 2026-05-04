import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { assertBrowserNavigationUrl } from '../../container/shared/browser-navigation.js';
import { BROWSER_PROFILE_CHROMIUM_ARGS } from '../../container/shared/browser-profile.js';
import { DATA_DIR } from '../config/config.js';
import type { SecretHandle } from '../security/secret-handles.js';
import type { SecretInput } from '../security/secret-refs.js';
import { getBrowserProfileDir } from './browser-login.js';
import {
  fillBrowserField,
  loadPlaywrightModule,
  normalizeScrollDelta,
  type PlaywrightNavigationOptions,
  toNavigationOptions,
} from './playwright-utils.js';
import type {
  BrowserEvaluateFunction,
  BrowserProvider,
  BrowserSession,
  ClickOptions,
  HistoryNavigationOptions,
  NavigateOptions,
  ScreenshotOptions,
  ScrollOptions,
  SessionOptions,
  WaitOptions,
} from './provider.js';

type PlaywrightScreenshotOptions = {
  fullPage?: boolean;
  type?: 'png' | 'jpeg';
};

type PlaywrightPage = {
  evaluate<T>(fn: BrowserEvaluateFunction<T>): Promise<T>;
  screenshot(opts?: PlaywrightScreenshotOptions): Promise<Buffer | Uint8Array>;
  goto(url: string, opts?: PlaywrightNavigationOptions): Promise<unknown>;
  goBack(opts?: PlaywrightNavigationOptions): Promise<unknown>;
  goForward(opts?: PlaywrightNavigationOptions): Promise<unknown>;
  reload(opts?: PlaywrightNavigationOptions): Promise<unknown>;
  click(selector: string, opts?: { timeout?: number }): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  mouse: {
    wheel(deltaX: number, deltaY: number): Promise<void>;
  };
  waitForSelector(
    selector: string,
    opts?: { state?: WaitOptions['state']; timeout?: number },
  ): Promise<unknown>;
  locator(selector: string): {
    evaluate<TArg>(
      fn: (element: Element, arg: TArg) => void,
      arg: TArg,
    ): Promise<void>;
  };
};

type PlaywrightContext = {
  pages(): PlaywrightPage[];
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
};

export type LocalBrowserPlaywrightModule = {
  chromium: {
    launchPersistentContext(
      userDataDir: string,
      opts: {
        headless: boolean;
        timeout?: number;
        args: string[];
      },
    ): Promise<PlaywrightContext>;
  };
};

export interface LocalBrowserProviderOptions {
  dataDir?: string;
  profileRoot?: string;
  headed?: boolean;
  playwright?: LocalBrowserPlaywrightModule;
  secretAudit?: (handle: SecretHandle, reason: string) => void;
}

function isPathWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Some mounted filesystems ignore chmod; profile confinement still relies
    // on path validation before Chromium receives the directory.
  }
}

function resolveProfileRoot(options: LocalBrowserProviderOptions): string {
  const envProfileRoot = process.env.BROWSER_SHARED_PROFILE_DIR?.trim();
  if (options.profileRoot) return path.resolve(options.profileRoot);
  if (options.dataDir)
    return path.resolve(getBrowserProfileDir(options.dataDir));
  if (envProfileRoot) return path.resolve(envProfileRoot);
  return path.resolve(getBrowserProfileDir(DATA_DIR));
}

function nearestExistingAncestor(targetPath: string): string {
  let current = path.resolve(targetPath);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function resolveConstrainedProfileDir(
  profileRoot: string,
  hint?: string,
): string {
  ensurePrivateDir(profileRoot);
  const realRoot = fs.realpathSync(profileRoot);
  const profileDir = path.resolve(hint || profileRoot);

  if (!isPathWithin(profileRoot, profileDir)) {
    throw new Error(
      `Browser profile directory must stay under ${profileRoot}: ${profileDir}`,
    );
  }

  if (profileDir === profileRoot) return realRoot;

  const existingAncestor = nearestExistingAncestor(profileDir);
  const realAncestor = fs.realpathSync(existingAncestor);
  if (!isPathWithin(realRoot, realAncestor)) {
    throw new Error(
      `Browser profile directory resolves outside ${realRoot}: ${realAncestor}`,
    );
  }

  ensurePrivateDir(profileDir);

  const realProfileDir = fs.realpathSync(profileDir);
  if (!isPathWithin(realRoot, realProfileDir)) {
    throw new Error(
      `Browser profile directory resolves outside ${realRoot}: ${realProfileDir}`,
    );
  }

  return realProfileDir;
}

async function loadPlaywright(
  injected?: LocalBrowserPlaywrightModule,
): Promise<LocalBrowserPlaywrightModule> {
  return await loadPlaywrightModule(
    injected,
    (cause) =>
      `Playwright is not available. Run npm install, then hybridclaw doctor browser-use --fix. Cause: ${cause}`,
  );
}

class LocalBrowserSession implements BrowserSession {
  constructor(
    private readonly page: PlaywrightPage,
    private readonly secretAudit?: (
      handle: SecretHandle,
      reason: string,
    ) => void,
  ) {}

  async evaluate<T>(fn: BrowserEvaluateFunction<T>): Promise<T> {
    return await this.page.evaluate(fn);
  }

  async screenshot(opts?: ScreenshotOptions): Promise<Buffer> {
    const bytes = await this.page.screenshot({
      fullPage: opts?.fullPage,
      type: opts?.type,
    });
    return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  }

  async navigate(url: string, opts?: NavigateOptions): Promise<void> {
    const parsed = await assertBrowserNavigationUrl(url);
    await this.page.goto(parsed.toString(), toNavigationOptions(opts));
  }

  async back(opts?: HistoryNavigationOptions): Promise<void> {
    await this.page.goBack(toNavigationOptions(opts));
  }

  async forward(opts?: HistoryNavigationOptions): Promise<void> {
    await this.page.goForward(toNavigationOptions(opts));
  }

  async reload(opts?: HistoryNavigationOptions): Promise<void> {
    await this.page.reload(toNavigationOptions(opts));
  }

  async click(selector: string, opts?: ClickOptions): Promise<void> {
    await this.page.click(selector, { timeout: opts?.timeoutMs });
  }

  async fill(selector: string, value: SecretInput): Promise<void> {
    await fillBrowserField(this.page, selector, value, this.secretAudit);
  }

  async scroll(opts: ScrollOptions): Promise<void> {
    const delta = normalizeScrollDelta(opts);
    if (opts.selector) {
      await this.page
        .locator(opts.selector)
        .evaluate((element, scrollDelta) => {
          element.scrollBy(scrollDelta.deltaX, scrollDelta.deltaY);
        }, delta);
      return;
    }

    await this.page.mouse.wheel(delta.deltaX, delta.deltaY);
  }

  async waitForSelector(selector: string, opts?: WaitOptions): Promise<void> {
    await this.page.waitForSelector(selector, {
      state: opts?.state,
      timeout: opts?.timeoutMs,
    });
  }
}

export class LocalBrowserProvider implements BrowserProvider {
  private readonly profileRoot: string;
  private readonly contexts = new WeakMap<
    LocalBrowserSession,
    PlaywrightContext
  >();

  constructor(private readonly options: LocalBrowserProviderOptions = {}) {
    this.profileRoot = resolveProfileRoot(options);
  }

  async launchSession(opts: SessionOptions): Promise<BrowserSession> {
    const profileDir = resolveConstrainedProfileDir(
      this.profileRoot,
      opts.profileDirHint,
    );
    const playwright = await loadPlaywright(this.options.playwright);
    const context = await playwright.chromium.launchPersistentContext(
      profileDir,
      {
        headless: !(opts.headed ?? this.options.headed ?? false),
        timeout: opts.timeoutMs,
        args: [...BROWSER_PROFILE_CHROMIUM_ARGS],
      },
    );
    const page = context.pages()[0] || (await context.newPage());
    const session = new LocalBrowserSession(page, this.options.secretAudit);
    this.contexts.set(session, context);
    return session;
  }

  async closeSession(session: BrowserSession): Promise<void> {
    if (!(session instanceof LocalBrowserSession)) {
      throw new Error('LocalBrowserProvider can only close its own sessions');
    }
    const context = this.contexts.get(session);
    if (!context) {
      throw new Error('LocalBrowserProvider session is not active');
    }
    this.contexts.delete(session);
    await context.close();
  }
}
