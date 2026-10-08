/**
 * Browser provider registry — maps `browser.provider` to the code that builds
 * it. `local` (Playwright Chromium on the gateway host) is built in; every
 * other kind is registered by a plugin through `api.registerBrowserProvider`.
 * An unregistered kind throws: it never falls back to `local`, because an
 * operator who picked a remote pool or their own desktop browser must not get
 * a different browser with different reach.
 *
 * NOT the per-chat session cache (`gateway-http-server.ts`) and not the
 * capability surface handed to providers (`provider-host.ts`).
 */
import type { RuntimeBrowserConfig } from '../config/runtime-config.js';
import type { SecretHandle } from '../security/secret-handles.js';
import {
  type LocalBrowserPlaywrightModule,
  LocalBrowserProvider,
} from './local-provider.js';
import type { BrowserProvider } from './provider.js';
import {
  type BrowserProviderHost,
  createBrowserProviderHost,
} from './provider-host.js';

export const LOCAL_BROWSER_PROVIDER = 'local';

export interface BrowserProviderRegistration {
  /** The `browser.provider` value that selects this provider. */
  kind: string;
  create(host: BrowserProviderHost): BrowserProvider;
}

let providers = new Map<string, BrowserProviderRegistration>();
// Bumped on every registry change so cached sessions built by a replaced
// registration (a plugin reload or config edit) are rebuilt.
let revision = 0;

export function registerBrowserProvider(
  registration: BrowserProviderRegistration,
): void {
  const kind = String(registration?.kind || '');
  if (!kind || kind !== kind.trim().toLowerCase()) {
    throw new Error(
      'Browser provider `kind` must be a non-empty lowercase string.',
    );
  }
  if (typeof registration.create !== 'function') {
    throw new Error(`Browser provider "${kind}" is missing \`create\`.`);
  }
  if (kind === LOCAL_BROWSER_PROVIDER || providers.has(kind)) {
    throw new Error(`Browser provider "${kind}" is already registered.`);
  }
  providers.set(kind, registration);
  revision += 1;
}

export function browserProviderRegistryRevision(): number {
  return revision;
}

export function snapshotBrowserProviders(): Map<
  string,
  BrowserProviderRegistration
> {
  return new Map(providers);
}

export function restoreBrowserProviders(
  snapshot: Map<string, BrowserProviderRegistration>,
): void {
  providers = new Map(snapshot);
  revision += 1;
}

export function clearBrowserProviders(): void {
  providers.clear();
  revision += 1;
}

export function createBrowserProvider(
  config: RuntimeBrowserConfig,
  deps: {
    localPlaywright?: LocalBrowserPlaywrightModule;
    secretAudit?: (handle: SecretHandle, reason: string) => void;
  } = {},
): BrowserProvider {
  if (config.provider === LOCAL_BROWSER_PROVIDER) {
    return new LocalBrowserProvider({
      profileRoot: config.local.profileRoot || undefined,
      headed: config.local.headed,
      allowPrivateNetwork: config.allowPrivateNetwork,
      playwright: deps.localPlaywright,
      secretAudit: deps.secretAudit,
    });
  }
  const registration = providers.get(config.provider);
  if (!registration) {
    throw new Error(
      `Browser provider "${config.provider}" is not available: no enabled plugin registers it. Install the plugin that provides it (for a bundled provider: hybridclaw plugin install ${config.provider}), or set browser.provider to "${LOCAL_BROWSER_PROVIDER}".`,
    );
  }
  return registration.create(
    createBrowserProviderHost({
      allowPrivateNetwork: config.allowPrivateNetwork,
      secretAudit: deps.secretAudit,
    }),
  );
}
