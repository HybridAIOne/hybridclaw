import { checkManagedBrowserPoolHealth } from './pool-health.js';
import { ManagedCloudBrowserProvider } from './provider.js';

const POOL_TOKEN = 'MANAGED_BROWSER_POOL_TOKEN';

export default {
  id: 'managed-cloud',
  register(api) {
    const config = api.pluginConfig;
    const getPoolToken = () => api.getCredential(POOL_TOKEN);

    api.registerBrowserProvider({
      kind: 'managed-cloud',
      create: (host) =>
        new ManagedCloudBrowserProvider({
          host,
          endpointUrl: config.endpointUrl,
          getPoolToken,
          defaultTenantId: config.defaultTenantId || undefined,
          pricing: config.pricing,
        }),
    });

    api.registerCommand({
      name: 'browser-pool',
      description: 'Check managed browser pool health',
      async handler(args) {
        const sub = String(args[0] || 'doctor').toLowerCase();
        if (sub !== 'doctor') {
          return {
            kind: 'error',
            title: 'Usage',
            text: 'Usage: `browser-pool doctor`',
          };
        }
        const result = await checkManagedBrowserPoolHealth({
          endpointUrl: config.endpointUrl,
          poolToken: getPoolToken(),
        });
        return {
          kind: result.ok ? 'info' : 'error',
          title: 'Managed Browser Pool',
          text: [
            result.message,
            `Endpoint: ${result.endpointUrl}`,
            `Nodes: ${result.healthyNodeCount}/${result.nodeCount}`,
          ].join('\n'),
        };
      },
    });
  },
};
