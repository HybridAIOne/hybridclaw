/**
 * Console access to the `published-tools` plugin's tool list.
 *
 * Reads the list from the runtime config and writes it back through the
 * `plugin config` command, which validates against the plugin's schema,
 * reloads plugins, and rolls back a write the plugin rejects. The plugin's
 * config schema stays the one definition of a published tool; this module
 * adds no gateway route and does no validation of its own.
 */
import { buildWebCommandRequestBody, requestJson } from './client';
import type {
  AdminCommandResult,
  AdminConfigResponse,
  AdminPluginsResponse,
  AdminSecretsResponse,
} from './types';

export const PUBLISHED_TOOLS_PLUGIN_ID = 'published-tools';
export const PUBLISHED_TOOLS_TOKEN_NAME = 'PUBLISHED_TOOLS_TOKEN';
export const PUBLISHED_TOOLS_ENDPOINT_PATH = `/api/plugin-webhooks/${PUBLISHED_TOOLS_PLUGIN_ID}/mcp`;

/** One entry of the plugin's `tools` config, as stored. */
export interface PublishedTool {
  name: string;
  title?: string;
  description: string;
  instructions?: string;
  agentId?: string;
  allowedTools: string[];
}

export interface PublishedToolsState {
  plugin: { status: 'loaded' | 'failed'; error: string | null } | null;
  tokenSet: boolean;
  tools: PublishedTool[];
  agentIds: string[];
  defaultAgentId: string;
}

interface ConfigShape {
  plugins?: { list?: Array<{ id: string; config?: { tools?: unknown } }> };
  agents?: { defaultAgentId?: string; list?: Array<{ id?: string }> };
}

export async function fetchPublishedTools(
  token: string,
): Promise<PublishedToolsState> {
  const [configResponse, pluginsResponse, secretsResponse] = await Promise.all([
    requestJson<AdminConfigResponse>('/api/admin/config', { token }),
    requestJson<AdminPluginsResponse>('/api/admin/plugins', { token }),
    requestJson<AdminSecretsResponse>('/api/admin/secrets', { token }),
  ]);
  const config = configResponse.config as unknown as ConfigShape;
  const plugin = pluginsResponse.plugins.find(
    (entry) => entry.id === PUBLISHED_TOOLS_PLUGIN_ID,
  );
  const tools = config.plugins?.list?.find(
    (entry) => entry.id === PUBLISHED_TOOLS_PLUGIN_ID,
  )?.config?.tools;
  const defaultAgentId = config.agents?.defaultAgentId || 'main';
  const agentIds = [
    ...new Set([
      defaultAgentId,
      ...(config.agents?.list ?? []).flatMap((agent) =>
        agent.id ? [agent.id] : [],
      ),
    ]),
  ];
  return {
    plugin: plugin ? { status: plugin.status, error: plugin.error } : null,
    tokenSet: secretsResponse.secrets.some(
      (secret) =>
        secret.name === PUBLISHED_TOOLS_TOKEN_NAME && secret.state === 'set',
    ),
    tools: Array.isArray(tools) ? (tools as PublishedTool[]) : [],
    agentIds,
    defaultAgentId,
  };
}

/** Replaces the whole tool list; throws with the gateway's reason on rejection. */
export async function savePublishedTools(
  token: string,
  tools: PublishedTool[],
): Promise<void> {
  const result = await requestJson<AdminCommandResult>('/api/command', {
    token,
    method: 'POST',
    body: buildWebCommandRequestBody({
      sessionId: 'web-admin-plugins',
      args: [
        'plugin',
        'config',
        PUBLISHED_TOOLS_PLUGIN_ID,
        'tools',
        JSON.stringify(tools),
      ],
    }),
  });
  if (result.kind === 'error') throw new Error(result.text);
}
