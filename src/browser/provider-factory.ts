import type { RuntimeBrowserConfig } from '../config/runtime-config.js';
import type { SecretHandle } from '../security/secret-handles.js';
import { BrowserUseCloudProvider } from './browser-use-cloud-provider.js';
import { type CamofoxModule, CamofoxProvider } from './camofox-provider.js';
import {
  type LocalBrowserPlaywrightModule,
  LocalBrowserProvider,
} from './local-provider.js';
import {
  ManagedCloudBrowserProvider,
  type ManagedCloudPlaywrightModule,
} from './managed-cloud-provider.js';
import type { BrowserProvider } from './provider.js';

export interface BrowserProviderFactoryDeps {
  localPlaywright?: LocalBrowserPlaywrightModule;
  camofox?: CamofoxModule;
  managedCloudPlaywright?: ManagedCloudPlaywrightModule;
  secretAudit?: (handle: SecretHandle, reason: string) => void;
}

export function createBrowserProvider(
  config: RuntimeBrowserConfig,
  deps: BrowserProviderFactoryDeps = {},
): BrowserProvider {
  switch (config.provider) {
    case 'camofox':
      return new CamofoxProvider({
        profileRoot: config.camofox.profileRoot || undefined,
        headed: config.camofox.headed,
        launchOptions: config.camofox.launchOptions,
        camofox: deps.camofox,
        secretAudit: deps.secretAudit,
      });
    case 'browser-use-cloud':
      return new BrowserUseCloudProvider({
        apiKeyRef: config.browserUseCloud.apiKeyRef,
        baseUrl: config.browserUseCloud.baseUrl || undefined,
        browser: config.browserUseCloud.browser,
        pricing: config.browserUseCloud.pricing,
        secretAudit: deps.secretAudit,
      });
    case 'managed-cloud':
      return new ManagedCloudBrowserProvider({
        endpointUrl: config.managedCloud.endpointUrl || undefined,
        poolTokenRef: config.managedCloud.poolTokenRef,
        defaultTenantId: config.managedCloud.defaultTenantId || undefined,
        pricing: config.managedCloud.pricing,
        playwright: deps.managedCloudPlaywright,
        secretAudit: deps.secretAudit,
      });
    default:
      return new LocalBrowserProvider({
        profileRoot: config.local.profileRoot || undefined,
        headed: config.local.headed,
        playwright: deps.localPlaywright,
        secretAudit: deps.secretAudit,
      });
  }
}
