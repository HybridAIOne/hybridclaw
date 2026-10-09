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

interface RegisteredBrowserProvider {
  registration: BrowserProviderRegistration;
  /** Equal across a reload only when the plugin and its config are unchanged. */
  fingerprint: string;
}

let providers = new Map<string, RegisteredBrowserProvider>();

export function registerBrowserProvider(
  registration: BrowserProviderRegistration,
  fingerprint: string,
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
  providers.set(kind, { registration, fingerprint });
}

/**
 * Cached sessions of `kind` are rebuilt when this changes, so reloading an
 * unrelated plugin keeps them open. `''` when nothing registers the kind.
 */
export function browserProviderFingerprint(kind: string): string {
  return providers.get(kind)?.fingerprint ?? '';
}

export function snapshotBrowserProviders(): Map<
  string,
  RegisteredBrowserProvider
> {
  return new Map(providers);
}

export function restoreBrowserProviders(
  snapshot: Map<string, RegisteredBrowserProvider>,
): void {
  providers = new Map(snapshot);
}

export function clearBrowserProviders(): void {
  providers.clear();
}

export function createBrowserProvider(
  config: RuntimeBrowserConfig,
  deps: {
    localPlaywright?: LocalBrowserPlaywrightModule;
    secretAudit?: (handle: SecretHandle, reason: string) => void;
    /** Why the plugin with the kind's id failed to load, if it did. */
    pluginLoadError?: string;
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
  const registration = providers.get(config.provider)?.registration;
  if (!registration && deps.pluginLoadError) {
    throw new Error(
      `Browser provider "${config.provider}" is not available: the ${config.provider} plugin failed to load: ${deps.pluginLoadError}`,
    );
  }
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
