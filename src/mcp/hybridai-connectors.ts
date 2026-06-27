import { HYBRIDAI_API_KEY, HYBRIDAI_BASE_URL } from '../config/config.js';
import type { McpServerConfig } from '../types/models.js';

export const HYBRIDAI_CONNECTORS_MCP_SERVER_NAME = 'hybridai';
export const HYBRIDAI_CONNECTORS_MCP_PATH = '/api/v1/connectors/mcp';

interface HybridAIConnectorsMcpOptions {
  apiKey?: string;
  baseUrl?: string;
  mapUrl?: (url: string) => string;
}

function normalizeBaseUrl(raw: string | undefined): string {
  return String(raw || HYBRIDAI_BASE_URL || 'https://hybridai.one')
    .trim()
    .replace(/\/+$/g, '');
}

function resolveGatewayUrl(options: HybridAIConnectorsMcpOptions): string {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const url = `${baseUrl}${HYBRIDAI_CONNECTORS_MCP_PATH}`;
  return options.mapUrl ? options.mapUrl(url) : url;
}

export function withAutoHybridAIConnectorsMcpServer(
  servers: Record<string, McpServerConfig>,
  options: HybridAIConnectorsMcpOptions = {},
): Record<string, McpServerConfig> {
  const apiKey = String(options.apiKey ?? HYBRIDAI_API_KEY).trim();
  if (!apiKey) return servers;

  const existing = servers[HYBRIDAI_CONNECTORS_MCP_SERVER_NAME];
  if (existing?.enabled === false) return servers;

  const headers = { ...(existing?.headers || {}) };
  headers.Authorization = `Bearer ${apiKey}`;

  return {
    ...servers,
    [HYBRIDAI_CONNECTORS_MCP_SERVER_NAME]: {
      transport: 'http',
      url: existing?.url?.trim() || resolveGatewayUrl(options),
      headers,
      enabled: true,
    },
  };
}
