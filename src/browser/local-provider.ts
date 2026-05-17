import { BROWSER_PROFILE_CHROMIUM_ARGS } from '../../container/shared/browser-profile.js';
import type { SecretHandle } from '../security/secret-handles.js';
import {
  loadPlaywrightModule,
  PlaywrightBrowserSession,
  type PlaywrightContextShape,
  type PlaywrightPageShape,
} from './playwright-utils.js';
import {
  resolveBrowserProfileRoot,
  resolveConstrainedBrowserProfileDir,
} from './profile-dir.js';
import type {
  BrowserProvider,
  BrowserProviderCapabilities,
  BrowserSession,
  SessionOptions,
} from './provider.js';
import { DEFAULT_BROWSER_PROVIDER_CAPABILITIES } from './provider.js';

type PlaywrightPage = PlaywrightPageShape;
type PlaywrightContext = PlaywrightContextShape<PlaywrightPage>;

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
  /** Test/direct-construction fallback; production config passes profileRoot. */
  dataDir?: string;
  profileRoot?: string;
  headed?: boolean;
  playwright?: LocalBrowserPlaywrightModule;
  secretAudit?: (handle: SecretHandle, reason: string) => void;
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

class LocalBrowserSession extends PlaywrightBrowserSession<PlaywrightPage> {}

export class LocalBrowserProvider implements BrowserProvider {
  private readonly profileRoot: string;
  private readonly contexts = new WeakMap<
    LocalBrowserSession,
    PlaywrightContext
  >();

  constructor(private readonly options: LocalBrowserProviderOptions = {}) {
    this.profileRoot = resolveBrowserProfileRoot(options);
  }

  async launchSession(opts: SessionOptions): Promise<BrowserSession> {
    const profileDir = resolveConstrainedBrowserProfileDir(
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
    const session = new LocalBrowserSession(
      page,
      this.options.secretAudit,
      opts.metering,
    );
    this.contexts.set(session, context);
    return session;
  }

  getCapabilities(): BrowserProviderCapabilities {
    return DEFAULT_BROWSER_PROVIDER_CAPABILITIES;
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
