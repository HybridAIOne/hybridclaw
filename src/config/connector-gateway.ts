import type { RuntimeConfig } from './runtime-config.js';

/**
 * Name of the auto-wired MCP server entry pointing at the HybridAI chat
 * platform's connector gateway.
 */
export const CONNECTOR_GATEWAY_SERVER_NAME = 'hybridai-connectors';

/**
 * Auto-wire the HybridAI connector gateway as an MCP server when the HybridAI
 * provider is configured.
 *
 * On self-hosted installs this means simply configuring the HybridAI provider
 * (base URL + API key) is enough to give agents the platform's connectors and
 * first-party tools — no manual `mcpServers` entry needed. The entry is injected
 * into the in-memory server map only (never persisted to config.json), so the
 * API key is not written to disk. A user-defined server of the same name always
 * wins, and the entry is omitted when the provider isn't configured.
 */
export function injectHybridAIConnectorGateway(
  servers: RuntimeConfig['mcpServers'],
  baseUrl: string,
  apiKey: string,
): RuntimeConfig['mcpServers'] {
  const trimmedKey = apiKey.trim();
  const trimmedBase = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmedKey || !trimmedBase) return servers;
  if (servers[CONNECTOR_GATEWAY_SERVER_NAME]) return servers;

  return {
    ...servers,
    [CONNECTOR_GATEWAY_SERVER_NAME]: {
      transport: 'http',
      url: `${trimmedBase}/connectors/mcp`,
      headers: { Authorization: `Bearer ${trimmedKey}` },
      enabled: true,
    },
  };
}
