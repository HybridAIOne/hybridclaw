import type { RuntimeConfig } from './runtime-config.js';

/**
 * Name of the auto-wired MCP server entry pointing at the HybridAI connectors
 * MCP endpoint.
 */
export const CONNECTOR_GATEWAY_SERVER_NAME = 'hybridai-connectors';

function connectorGatewayUrl(baseUrl: string): string {
  const trimmedBase = baseUrl.trim().replace(/\/+$/, '');
  return trimmedBase ? `${trimmedBase}/api/v1/connectors/mcp` : '';
}

/**
 * Auto-wire the HybridAI connector gateway as an MCP server when the HybridAI
 * provider is configured.
 *
 * On self-hosted installs this means simply configuring the HybridAI provider
 * (base URL + API key) is enough to give agents HybridAI connectors and
 * first-party tools — no manual `mcpServers` entry needed. The entry is injected
 * into the in-memory server map only (never persisted to config.json). A
 * user-defined server of the same name always wins, and the entry is omitted
 * when the provider isn't configured or when `enabled` is false (the
 * `hybridai.enableConnectors` config flag).
 *
 * The entry deliberately carries NO Authorization header: the API key is
 * resolved per agent run by {@link withConnectorGatewayAuth}, so the long-lived
 * server map can be listed/logged without exposing the credential.
 */
export function injectHybridAIConnectorGateway(
  servers: RuntimeConfig['mcpServers'],
  baseUrl: string,
  apiKey: string,
  enabled = true,
): RuntimeConfig['mcpServers'] {
  if (!enabled) return servers;
  const url = connectorGatewayUrl(baseUrl);
  if (!apiKey.trim() || !url) return servers;
  if (servers[CONNECTOR_GATEWAY_SERVER_NAME]) return servers;

  return {
    ...servers,
    [CONNECTOR_GATEWAY_SERVER_NAME]: {
      transport: 'http',
      url,
      enabled: true,
    },
  };
}

/**
 * Attach the HybridAI API key to the connector gateway entry, returning a new
 * map (the input is never mutated). Called by the host/container runners right
 * before the server map is handed to an agent run, so the credential lives
 * only in the per-run payload — never in the long-lived `MCP_SERVERS` map.
 *
 * The header is attached only when the entry's URL is exactly the gateway URL
 * derived from the configured base URL — a user-defined entry pointing
 * anywhere else never receives the key — and an existing Authorization header
 * is always left untouched.
 */
export function withConnectorGatewayAuth(
  servers: RuntimeConfig['mcpServers'],
  baseUrl: string,
  apiKey: string,
): RuntimeConfig['mcpServers'] {
  const trimmedKey = apiKey.trim();
  const url = connectorGatewayUrl(baseUrl);
  if (!trimmedKey || !url) return servers;

  const entry = servers[CONNECTOR_GATEWAY_SERVER_NAME];
  if (!entry || entry.url !== url) return servers;
  if (entry.headers?.Authorization) return servers;

  return {
    ...servers,
    [CONNECTOR_GATEWAY_SERVER_NAME]: {
      ...entry,
      headers: { ...entry.headers, Authorization: `Bearer ${trimmedKey}` },
    },
  };
}
