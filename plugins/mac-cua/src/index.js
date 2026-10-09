import { MacCuaBrowserProvider } from './provider.js';
import { buildCuaMacResults } from './readiness.js';

export default {
  id: 'mac-cua',
  register(api) {
    const config = api.pluginConfig;
    api.registerBrowserProvider({
      kind: 'mac-cua',
      create: (host) =>
        new MacCuaBrowserProvider({
          host,
          browser: config.browser,
          driverCommand: config.driverCommand || undefined,
          driverArgs: config.driverArgs,
          screenshotMode: config.screenshotMode,
        }),
    });

    api.registerCommand({
      name: 'mac-cua',
      description: 'Check mac-cua driver and macOS permission readiness',
      handler(args) {
        if (String(args[0] || 'doctor').toLowerCase() !== 'doctor') {
          return {
            kind: 'error',
            title: 'Usage',
            text: 'Usage: `mac-cua doctor`',
          };
        }
        const results = buildCuaMacResults();
        return {
          kind: results.every((entry) => entry.severity === 'ok')
            ? 'info'
            : 'error',
          title: 'mac-cua Readiness',
          text: results
            .map(
              (entry) => `[${entry.severity}] ${entry.label}: ${entry.message}`,
            )
            .join('\n'),
        };
      },
    });
  },
};
