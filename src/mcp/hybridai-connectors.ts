/**
 * Auto-added HybridAI broker config declares only reviewed read contracts.
 * Exact operator overrides win; unlike MCP annotations, these defaults do not
 * trust every proxied connector or grant execution/approval permission.
 */
import { getHybridAIApiKey } from '../auth/hybridai-auth.js';
import {
  HYBRIDAI_BASE_URL,
  MissingRequiredEnvVarError,
} from '../config/config.js';
import type { McpServerConfig } from '../types/models.js';

export const HYBRIDAI_CONNECTORS_MCP_SERVER_NAME = 'hybridai';
export const HYBRIDAI_CONNECTORS_MCP_PATH = '/api/v1/connectors/mcp';

// Owner call, 2026-10-02: the platform's own web search only reads, so a batch
// of searches overlaps. HybridClaw declares it as the operator of this
// auto-added server; an operator's own `toolBehavior` entries win.
// Owner request, 2026-10-03: independent reads should overlap. The reviewed
// dm product search/details contracts only fetch public catalog data; trusting
// all broker-proxied annotations remains deliberately disabled.
const PLATFORM_READ_ONLY_TOOLS = {
  web_search: 'read-only',
  dm__searchProducts: 'read-only',
  dm__getProductDetails: 'read-only',
} as const;

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
  let apiKey = String(options.apiKey ?? '').trim();
  if (!apiKey) {
    try {
      apiKey = getHybridAIApiKey();
    } catch (error) {
      if (!(error instanceof MissingRequiredEnvVarError)) throw error;
    }
  }
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
      toolBehavior: {
        ...existing?.toolBehavior,
        overrides: {
          ...PLATFORM_READ_ONLY_TOOLS,
          ...existing?.toolBehavior?.overrides,
        },
      },
    },
  };
}
