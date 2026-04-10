import { logger } from '../logger.js';
import {
  ensurePluginManagerInitialized,
  type PluginManager,
} from '../plugins/plugin-manager.js';

export async function tryEnsurePluginManagerInitializedForGateway(params: {
  sessionId: string;
  channelId: string;
  agentId?: string | null;
  surface:
    | 'chat'
    | 'command'
    | 'webhook'
    | 'bootstrap'
    | 'heartbeat'
    | 'scheduler';
}): Promise<{
  pluginManager: PluginManager | null;
  pluginInitError: unknown;
}> {
  try {
    return {
      pluginManager: await ensurePluginManagerInitialized(),
      pluginInitError: null,
    };
  } catch (pluginInitError) {
    logger.warn(
      {
        sessionId: params.sessionId,
        channelId: params.channelId,
        agentId: params.agentId ?? null,
        surface: params.surface,
        error: pluginInitError,
      },
      'Plugin manager init failed; proceeding without plugins',
    );
    return { pluginManager: null, pluginInitError };
  }
}
