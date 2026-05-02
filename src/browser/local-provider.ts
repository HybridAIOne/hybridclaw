import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { assertBrowserNavigationUrl } from '../../container/shared/browser-navigation.js';
import { DATA_DIR } from '../config/config.js';
import type { SecretHandle } from '../security/secret-handles.js';
import {
  resolveSecretInputUnsafe,
  type SecretInput,
} from '../security/secret-refs.js';
import {
  BROWSER_PROFILE_CHROMIUM_ARGS,
  getBrowserProfileDir,
} from './browser-login.js';
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

type PlaywrightNavigationOptions = {
  waitUntil?: 'load' | 'domcontentloaded';
  timeout?: number;
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

const DEFAULT_SCROLL_DELTA = 800;

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
  return path.resolve(
    options.profileRoot ||
      (options.dataDir ? getBrowserProfileDir(options.dataDir) : undefined) ||
      envProfileRoot ||
      getBrowserProfileDir(DATA_DIR),
  );
}

function resolveConstrainedProfileDir(
  profileRoot: string,
  hint?: string,
): string {
  ensurePrivateDir(profileRoot);
  const profileDir = path.resolve(hint || profileRoot);

  if (!isPathWithin(profileRoot, profileDir)) {
    throw new Error(
      `Browser profile directory must stay under ${profileRoot}: ${profileDir}`,
    );
  }

  ensurePrivateDir(profileDir);

  const realRoot = fs.realpathSync(profileRoot);
  const realProfileDir = fs.realpathSync(profileDir);
  if (!isPathWithin(realRoot, realProfileDir)) {
    throw new Error(
      `Browser profile directory resolves outside ${realRoot}: ${realProfileDir}`,
    );
  }

  return realProfileDir;
}

function toNavigationOptions(
  opts?: NavigateOptions | HistoryNavigationOptions,
): PlaywrightNavigationOptions | undefined {
  if (!opts) return undefined;
  return {
    waitUntil: opts.waitUntil,
    timeout: opts.timeoutMs,
  };
}

function normalizeScrollDelta(opts: ScrollOptions): {
  deltaX: number;
  deltaY: number;
} {
  const explicitDeltaX = typeof opts.deltaX === 'number';
  const explicitDeltaY = typeof opts.deltaY === 'number';
  if (explicitDeltaX || explicitDeltaY) {
    return {
      deltaX: explicitDeltaX ? opts.deltaX || 0 : 0,
      deltaY: explicitDeltaY ? opts.deltaY || 0 : 0,
    };
  }

  switch (opts.direction) {
    case 'up':
      return { deltaX: 0, deltaY: -DEFAULT_SCROLL_DELTA };
    case 'left':
      return { deltaX: -DEFAULT_SCROLL_DELTA, deltaY: 0 };
    case 'right':
      return { deltaX: DEFAULT_SCROLL_DELTA, deltaY: 0 };
    default:
      return { deltaX: 0, deltaY: DEFAULT_SCROLL_DELTA };
  }
}

async function loadPlaywright(
  injected?: LocalBrowserPlaywrightModule,
): Promise<LocalBrowserPlaywrightModule> {
  if (injected) return injected;
  try {
    return (await import('playwright')) as LocalBrowserPlaywrightModule;
  } catch (error) {
    throw new Error(
      `Playwright is not available. Run npm install, then hybridclaw doctor browser-use --fix. Cause: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

class LocalBrowserSession implements BrowserSession {
  constructor(
    private readonly context: PlaywrightContext,
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
    const resolved =
      typeof value === 'string'
        ? value
        : resolveSecretInputUnsafe(value, {
            path: `browser.fill(${selector})`,
            required: true,
            reason: `fill browser field ${selector}`,
            audit: this.secretAudit || (() => {}),
          }) || '';
    await this.page.fill(selector, resolved);
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

  async close(): Promise<void> {
    await this.context.close();
  }
}

export class LocalBrowserProvider implements BrowserProvider {
  private readonly profileRoot: string;

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
    return new LocalBrowserSession(context, page, this.options.secretAudit);
  }

  async closeSession(session: BrowserSession): Promise<void> {
    if (!(session instanceof LocalBrowserSession)) {
      throw new Error('LocalBrowserProvider can only close its own sessions');
    }
    await session.close();
  }
}
