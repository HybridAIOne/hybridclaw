/**
 * Camofox browser provider — a stealth Firefox (camoufox-js) on the gateway
 * host. Each navigation passes the core private-network guard, then the
 * agent workspace's `browser.stealth` rules, which deny every host that no
 * rule allows. NOT the core `local` Chromium provider.
 */

let camofoxModulePromise = null;

async function launchCamofoxContext(camofox, launchOptions, timeoutMs) {
  const launchPromise = camofox.Camoufox(launchOptions);
  if (timeoutMs === undefined) return await launchPromise;

  let timedOut = false;
  let timeoutHandle;
  const timeoutPromise = new Promise((_, reject) => {
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

async function loadCamofoxModule(injected, installDir) {
  if (injected) return injected;
  if (camofoxModulePromise) return await camofoxModulePromise;
  camofoxModulePromise = import('camoufox-js');
  try {
    return await camofoxModulePromise;
  } catch (error) {
    camofoxModulePromise = null;
    const cause = error instanceof Error ? error.message : String(error);
    // The bundled copy has no dependencies; `plugin install` fetches them.
    throw new Error(
      `Camofox is not available: run \`hybridclaw plugin install camofox\`, then \`npx camoufox-js fetch\` in ${installDir || 'the installed camofox plugin directory'}. Cause: ${cause}`,
    );
  }
}

export class CamofoxProvider {
  contexts = new WeakMap();

  /**
   * @param {{
   *   host: import('@hybridaione/hybridclaw/plugin-sdk').BrowserProviderHost,
   *   dataDir?: string,
   *   installDir?: string,
   *   profileRoot?: string,
   *   headed?: boolean,
   *   launchOptions?: Record<string, unknown>,
   *   camofox?: { Camoufox(options: Record<string, unknown>): Promise<unknown> },
   *   stealthPolicy?: (context: { host: string, metering?: Record<string, string> }) => void | Promise<void>,
   * }} options
   */
  constructor(options) {
    this.options = options;
    this.host = options.host;
    this.profileRoot = this.host.profiles.resolveRoot(options);
    const host = this.host;
    this.Session = class CamofoxSession extends host.playwright.BrowserSession {
      constructor(page, meteringContext, stealthPolicy) {
        super(
          page,
          host.secretAudit,
          meteringContext,
          host.allowPrivateNetwork,
        );
        this.meteringContext = meteringContext;
        this.stealthPolicy = stealthPolicy;
      }

      async navigate(url, opts) {
        const parsed = await host.navigation.assertUrl(url, {
          allowPrivateNetwork: host.allowPrivateNetwork,
        });
        if (parsed.hostname) {
          await this.stealthPolicy({
            host: parsed.hostname,
            metering: this.meteringContext,
          });
        }
        await this.page.goto(
          parsed.toString(),
          host.playwright.toNavigationOptions(opts),
        );
      }
    };
  }

  async launchSession(opts) {
    const profileDir = this.host.profiles.resolveDir(
      this.profileRoot,
      opts.profileDirHint,
    );
    const camofox = await loadCamofoxModule(
      this.options.camofox,
      this.options.installDir,
    );
    const headed = opts.headed ?? this.options.headed ?? false;
    const launchOptions = {
      ...this.options.launchOptions,
      user_data_dir: profileDir,
      headless: !headed,
    };

    const context = await launchCamofoxContext(
      camofox,
      launchOptions,
      opts.timeoutMs,
    );
    const page = context.pages()[0] || (await context.newPage());
    const session = new this.Session(
      page,
      opts.metering,
      this.options.stealthPolicy ||
        ((policyContext) =>
          this.host.stealth.assertAllowed({
            host: policyContext.host,
            agentId: policyContext.metering?.agentId,
            skillName: policyContext.metering?.skillName,
          })),
    );
    session.headed = headed;
    this.contexts.set(session, context);
    return session;
  }

  getCapabilities() {
    return this.host.capabilities;
  }

  async closeSession(session) {
    if (!(session instanceof this.Session)) {
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
