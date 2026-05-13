import { getAgentById } from '../agents/agent-registry.js';
import {
  BRAVE_API_KEY,
  PERPLEXITY_API_KEY,
  TAVILY_API_KEY,
  WEB_SEARCH_CACHE_TTL_MINUTES,
  WEB_SEARCH_DEFAULT_COUNT,
  WEB_SEARCH_FALLBACK_PROVIDERS,
  WEB_SEARCH_PROVIDER,
  WEB_SEARCH_SEARXNG_BASE_URL,
  WEB_SEARCH_SEARXNG_BEARER_TOKEN_REF,
  WEB_SEARCH_TAVILY_SEARCH_DEPTH,
} from '../config/config.js';
import type { WebSearchConfig } from '../types/container.js';

export function resolveWebSearchRuntimeConfig(
  agentId?: string,
): WebSearchConfig {
  const agentWebSearch = agentId ? getAgentById(agentId)?.webSearch : undefined;
  const searxngBaseUrl =
    agentWebSearch?.searxngBaseUrl || WEB_SEARCH_SEARXNG_BASE_URL;
  const searxngBearerTokenRef =
    agentWebSearch?.searxngBearerTokenRef ||
    WEB_SEARCH_SEARXNG_BEARER_TOKEN_REF;
  return {
    provider: WEB_SEARCH_PROVIDER,
    fallbackProviders: [...WEB_SEARCH_FALLBACK_PROVIDERS],
    defaultCount: WEB_SEARCH_DEFAULT_COUNT,
    cacheTtlMinutes: WEB_SEARCH_CACHE_TTL_MINUTES,
    searxngBaseUrl,
    ...(searxngBearerTokenRef ? { searxngBearerTokenRef } : {}),
    tavilySearchDepth: WEB_SEARCH_TAVILY_SEARCH_DEPTH,
    braveApiKey: BRAVE_API_KEY,
    perplexityApiKey: PERPLEXITY_API_KEY,
    tavilyApiKey: TAVILY_API_KEY,
  };
}
