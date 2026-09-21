/**
 * Concierge commands edit the shared router; this plugin never selects a model.
 * Classification and privacy enforcement belong to the gateway's tier policy.
 */
export default {
  id: 'concierge-router',
  kind: 'middleware',
  register(api) {
    api.registerCommand({
      name: 'concierge',
      description: 'Inspect routing or select its classifier',
      async handler(args) {
        if (args.length && args[0] !== 'info')
          return 'Configure routing in /admin/models.';
        const routing = api.getRoutingConfig();
        return `Routing: ${routing.enabled ? routing.mode : 'off'} · Preference: ${routing.preference} · Concierge: ${routing.concierge.model || 'none'}. Configure tiers in /admin/models.`;
      },
    });
  },
};
