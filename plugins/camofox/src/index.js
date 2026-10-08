import { normalizeCamofoxLaunchOptions } from './launch-options.js';
import { CamofoxProvider } from './provider.js';

export default {
  id: 'camofox',
  register(api) {
    const config = api.pluginConfig;
    // Validated at load so a bad option fails `plugin config`, not a turn.
    const launchOptions = normalizeCamofoxLaunchOptions(config.launchOptions);
    api.registerBrowserProvider({
      kind: 'camofox',
      create: (host) =>
        new CamofoxProvider({
          host,
          profileRoot: config.profileRoot || undefined,
          headed: config.headed === true,
          launchOptions,
        }),
    });
  },
};
