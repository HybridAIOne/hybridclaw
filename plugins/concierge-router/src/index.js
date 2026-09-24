/**
 * Concierge commands inspect the shared router; this plugin never selects a model.
 * Classification and privacy enforcement belong to the gateway's tier policy.
 */
export default {
  id: 'concierge-router',
  kind: 'middleware',
  register(api) {
    api.registerCommand({
      name: 'concierge',
      description: 'Inspect routing configuration',
      async handler(args) {
        if (args.length && args[0] !== 'info')
          return 'Configure routing in /admin/model-routing.';
        const routing = api.getRoutingConfig();
        return `Routing: ${routing.enabled ? routing.mode : 'off'} · Concierge: ${routing.concierge.model || 'none'}. Configure tiers in /admin/model-routing.`;
      },
    });
  },
};
