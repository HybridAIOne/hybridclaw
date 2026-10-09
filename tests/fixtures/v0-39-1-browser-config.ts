// compat: remove after v0.41 together with legacy-browser-plugin-migration.ts.
//
// The `browser` block `hybridclaw@0.39.1 config set browser.provider <kind>`
// saves (recorded from the published package): its normalizer wrote every
// provider section, with a clamped minimum for each field never set.
export const V0_39_1_BROWSER = {
  allowPrivateNetwork: false,
  local: { profileRoot: '', headed: false },
  camofox: { profileRoot: '', headed: false, launchOptions: {} },
  managedCloud: {
    endpointUrl: 'http://127.0.0.1:8787',
    defaultTenantId: '',
    pricing: { browserUsdPerMinute: 0, actionUsd: 0 },
  },
  browserUseCloud: {
    apiKeyRef: { source: 'store', id: 'BROWSER_USE_API_KEY' },
    baseUrl: '',
    browser: { timeoutMinutes: 1, browserScreenWidth: 1, browserScreenHeight: 1 },
    pricing: { browserUsdPerMinute: 0, actionUsd: 0 },
  },
  macCua: {
    browser: 'chrome',
    driverCommand: '',
    driverArgs: [] as string[],
    screenshotMode: 'som',
  },
};
