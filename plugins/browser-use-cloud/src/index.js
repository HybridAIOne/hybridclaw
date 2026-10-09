import { BrowserUseCloudProvider } from './provider.js';

export default {
  id: 'browser-use-cloud',
  register(api) {
    const config = api.pluginConfig;
    api.registerBrowserProvider({
      kind: 'browser-use-cloud',
      create: (host) =>
        new BrowserUseCloudProvider({
          host,
          getApiKey: () => api.getCredential('BROWSER_USE_API_KEY'),
          baseUrl: config.baseUrl || undefined,
          browser: config.browser,
          pricing: config.pricing,
        }),
    });
  },
};
