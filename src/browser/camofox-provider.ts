import type { LaunchOptions as CamofoxLaunchOptions } from 'camoufox-js';
import type { SecretHandle } from '../security/secret-handles.js';
import {
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
  BrowserSession,
  SessionOptions,
} from './provider.js';

type CamofoxPage = PlaywrightPageShape;
type CamofoxContext = PlaywrightContextShape<CamofoxPage>;

export type CamofoxModule = {
  Camoufox(
    launchOptions: CamofoxLaunchOptions & { user_data_dir: string },
  ): Promise<CamofoxContext>;
};

export interface CamofoxProviderOptions {
  /** Test/direct-construction fallback; production config passes profileRoot. */
  dataDir?: string;
  profileRoot?: string;
  headed?: boolean;
  launchOptions?: CamofoxLaunchOptions;
  camofox?: CamofoxModule;
  secretAudit?: (handle: SecretHandle, reason: string) => void;
}

let camofoxModulePromise: Promise<CamofoxModule> | null = null;

async function launchCamofoxContext(
  camofox: CamofoxModule,
  launchOptions: CamofoxLaunchOptions & { user_data_dir: string },
  timeoutMs?: number,
): Promise<CamofoxContext> {
  const launchPromise = camofox.Camoufox(launchOptions);
  if (timeoutMs === undefined) return await launchPromise;

  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      reject(new Error(`Camofox launch timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([launchPromise, timeoutPromise]);
  } catch (error) {
    if (timedOut) {
      launchPromise
        .then(async (context) => {
          await context.close();
        })
        .catch(() => undefined);
    }
    throw error;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

async function loadCamofoxModule(
  injected?: CamofoxModule,
): Promise<CamofoxModule> {
  if (injected) return injected;
  if (camofoxModulePromise) return await camofoxModulePromise;
  camofoxModulePromise = import('camoufox-js') as Promise<CamofoxModule>;
  try {
    return await camofoxModulePromise;
  } catch (error) {
    camofoxModulePromise = null;
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Camofox is not available. Run npm install, then npx camoufox-js fetch. Cause: ${cause}`,
    );
  }
}

class CamofoxSession extends PlaywrightBrowserSession<CamofoxPage> {}

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

    const context = await launchCamofoxContext(
      camofox,
      launchOptions,
      opts.timeoutMs,
    );
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
