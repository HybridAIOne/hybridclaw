import { callGatewayTool } from './gateway-client.js';
import { runMaintenance, startMaintenanceSchedule } from './maintenance.js';
import {
  buildKnowledgeContext,
  latestUserQuery,
  searchKnowledge,
} from './retrieval.js';

const LAYER_ID = 'hybridai-knowledge';
const MEMORY_LAYER_PRIORITY = 40;

function resolveConfig(pluginConfig) {
  const raw =
    pluginConfig && typeof pluginConfig === 'object' ? pluginConfig : {};
  const maintenance =
    raw.maintenance && typeof raw.maintenance === 'object'
      ? raw.maintenance
      : {};
  return Object.freeze({
    collections: Array.isArray(raw.collections)
      ? raw.collections.map((id) => String(id).trim()).filter(Boolean)
      : [],
    limit: Number.isFinite(raw.limit) ? Math.trunc(raw.limit) : 5,
    minScore: Number.isFinite(raw.minScore) ? raw.minScore : 0.2,
    maxInjectedChars: Number.isFinite(raw.maxInjectedChars)
      ? Math.trunc(raw.maxInjectedChars)
      : 4000,
    timeoutMs: Number.isFinite(raw.timeoutMs)
      ? Math.trunc(raw.timeoutMs)
      : 8000,
    maintenance: Object.freeze({
      enabled: maintenance.enabled === true,
      hourUtc: Number.isFinite(maintenance.hourUtc)
        ? Math.trunc(maintenance.hourUtc)
        : 3,
      agentId:
        typeof maintenance.agentId === 'string'
          ? maintenance.agentId.trim()
          : '',
      collection:
        typeof maintenance.collection === 'string'
          ? maintenance.collection.trim()
          : '',
    }),
  });
}

export default {
  id: LAYER_ID,
  register(api) {
    const config = resolveConfig(api.pluginConfig);
    const baseUrl = api.config?.hybridai?.baseUrl || 'https://hybridai.one';
    const credential = () =>
      (api.getCredential('HYBRIDAI_API_KEY') || '').trim();
    const callTool = (name, args) =>
      callGatewayTool({
        baseUrl,
        apiKey: credential(),
        name,
        args,
        timeoutMs: config.timeoutMs,
      });

    api.registerMemoryLayer({
      id: LAYER_ID,
      priority: MEMORY_LAYER_PRIORITY,
      async getContextForPrompt({ recentMessages }) {
        if (!credential()) return null;
        const query = latestUserQuery(recentMessages);
        if (!query) return null;
        const hits = await searchKnowledge({
          query,
          collections: config.collections,
          limit: config.limit,
          callTool,
          onError: (error) =>
            api.logger.warn(
              { error, timeoutMs: config.timeoutMs },
              'Knowledge retrieval failed',
            ),
        });
        const context = buildKnowledgeContext(hits, {
          maxInjectedChars: config.maxInjectedChars,
          minScore: config.minScore,
        });
        api.logger.debug(
          {
            hits: hits.length,
            injected: Boolean(context),
            collections: config.collections,
          },
          context
            ? 'Knowledge context injected'
            : 'Knowledge retrieval found nothing to inject',
        );
        return context;
      },
    });

    if (config.maintenance.enabled) {
      let stop = null;
      api.registerService({
        id: `${LAYER_ID}-maintenance`,
        async start() {
          stop = startMaintenanceSchedule({ api, config, run: runMaintenance });
        },
        async stop() {
          stop?.();
          stop = null;
        },
      });
    }
  },
};
