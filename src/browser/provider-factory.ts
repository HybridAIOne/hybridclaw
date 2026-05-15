import type { RuntimeBrowserConfig } from '../config/runtime-config.js';
import type { SecretHandle } from '../security/secret-handles.js';
import { BrowserUseCloudProvider } from './browser-use-cloud-provider.js';
import { type CamofoxModule, CamofoxProvider } from './camofox-provider.js';
import {
  type LocalBrowserPlaywrightModule,
  LocalBrowserProvider,
} from './local-provider.js';
import {
  MacCuaBrowserProvider,
  type MacCuaDriver,
} from './mac-cua-provider.js';
import type { BrowserProvider } from './provider.js';

export interface BrowserProviderFactoryDeps {
  localPlaywright?: LocalBrowserPlaywrightModule;
  camofox?: CamofoxModule;
  macCuaDriver?: MacCuaDriver;
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
    case 'mac-cua':
      return new MacCuaBrowserProvider({
        browser: config.macCua.browser,
        driverCommand: config.macCua.driverCommand || undefined,
        driverArgs: config.macCua.driverArgs,
        screenshotMode: config.macCua.screenshotMode,
        driver: deps.macCuaDriver,
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
