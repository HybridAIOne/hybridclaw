import { Buffer } from 'node:buffer';
import type { LaunchOptions as CamofoxLaunchOptions } from 'camoufox-js';
import { assertBrowserNavigationUrl } from '../../container/shared/browser-navigation.js';
import type { SecretHandle } from '../security/secret-handles.js';
import type { SecretInput } from '../security/secret-refs.js';
import {
  fillBrowserField,
  normalizeScrollDelta,
  type PlaywrightNavigationOptions,
  type PlaywrightSecretFillLocator,
  toNavigationOptions,
} from './playwright-utils.js';
import {
  resolveBrowserProfileRoot,
  resolveConstrainedBrowserProfileDir,
} from './profile-dir.js';
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

type CamofoxPage = {
  evaluate<T>(fn: BrowserEvaluateFunction<T>): Promise<T>;
  screenshot(opts?: PlaywrightScreenshotOptions): Promise<Buffer | Uint8Array>;
  goto(url: string, opts?: PlaywrightNavigationOptions): Promise<unknown>;
  goBack(opts?: PlaywrightNavigationOptions): Promise<unknown>;
  goForward(opts?: PlaywrightNavigationOptions): Promise<unknown>;
  reload(opts?: PlaywrightNavigationOptions): Promise<unknown>;
  click(selector: string, opts?: { timeout?: number }): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  url(): string;
  mouse: {
    wheel(deltaX: number, deltaY: number): Promise<void>;
  };
  waitForSelector(
    selector: string,
    opts?: { state?: WaitOptions['state']; timeout?: number },
  ): Promise<unknown>;
  locator(selector: string): PlaywrightSecretFillLocator & {
    evaluate<TArg>(
      fn: (element: Element, arg: TArg) => void,
      arg: TArg,
    ): Promise<void>;
  };
};

type CamofoxContext = {
  pages(): CamofoxPage[];
  newPage(): Promise<CamofoxPage>;
  close(): Promise<void>;
};

export type CamofoxModule = {
  Camoufox(
    launchOptions: CamofoxLaunchOptions & { user_data_dir: string },
  ): Promise<CamofoxContext>;
};

export interface CamofoxProviderOptions {
  dataDir?: string;
  profileRoot?: string;
  headed?: boolean;
  launchOptions?: CamofoxLaunchOptions;
  camofox?: CamofoxModule;
  secretAudit?: (handle: SecretHandle, reason: string) => void;
}

async function loadCamofoxModule(
  injected?: CamofoxModule,
): Promise<CamofoxModule> {
  if (injected) return injected;
  try {
    return (await import('camoufox-js')) as CamofoxModule;
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Camofox is not available. Run npm install, then npx camoufox-js fetch. Cause: ${cause}`,
    );
  }
}

class CamofoxSession implements BrowserSession {
  constructor(
    private readonly page: CamofoxPage,
    private readonly secretAudit?: (
      handle: SecretHandle,
      reason: string,
    ) => void,
    private readonly metering?: SessionOptions['metering'],
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
    await fillBrowserField(
      this.page,
      selector,
      value,
      this.secretAudit,
      this.metering,
    );
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

export class CamofoxProvider implements BrowserProvider {
  private readonly profileRoot: string;
  private readonly contexts = new WeakMap<CamofoxSession, CamofoxContext>();

  constructor(private readonly options: CamofoxProviderOptions = {}) {
    this.profileRoot = resolveBrowserProfileRoot(options);
  }

  async launchSession(opts: SessionOptions): Promise<BrowserSession> {
    const profileDir = resolveConstrainedBrowserProfileDir(
      this.profileRoot,
      opts.profileDirHint,
    );
    const camofox = await loadCamofoxModule(this.options.camofox);
    const launchOptions: CamofoxLaunchOptions & { user_data_dir: string } = {
      ...this.options.launchOptions,
      user_data_dir: profileDir,
      headless: !(opts.headed ?? this.options.headed ?? false),
    };
    if (opts.timeoutMs !== undefined) {
      launchOptions.timeout = opts.timeoutMs;
    }

    const context = await camofox.Camoufox(launchOptions);
    const page = context.pages()[0] || (await context.newPage());
    const session = new CamofoxSession(
      page,
      this.options.secretAudit,
      opts.metering,
    );
    this.contexts.set(session, context);
    return session;
  }

  async closeSession(session: BrowserSession): Promise<void> {
    if (!(session instanceof CamofoxSession)) {
      throw new Error('CamofoxProvider can only close its own sessions');
    }
    const context = this.contexts.get(session);
    if (!context) {
      throw new Error('CamofoxProvider session is not active');
    }
    this.contexts.delete(session);
    await context.close();
  }
}
