/**
 * Worker env — the environment contract every agent worker gets, in both
 * sandbox modes, as one `name → value` map.
 *
 * Values are config the worker reads at startup; the gateway token is the
 * derived per-scope runtime token, never the gateway's own secret. NOT the
 * sandbox-specific env: workspace and state roots, mounts, the sanitized host
 * env and the stored runtime env stay with each strategy.
 */
import type { ExecutorRequest } from '../agent/executor-types.js';
import {
  BROWSER_ALLOW_PRIVATE_NETWORK,
  GATEWAY_CLIENT_BASE_URL,
  HYBRIDAI_BASE_URL,
  HYBRIDAI_MODEL,
  PROACTIVE_AUTO_RETRY_BASE_DELAY_MS,
  PROACTIVE_AUTO_RETRY_ENABLED,
  PROACTIVE_AUTO_RETRY_MAX_ATTEMPTS,
  PROACTIVE_AUTO_RETRY_MAX_DELAY_MS,
  PROACTIVE_RALPH_MAX_ITERATIONS,
  WEB_SEARCH_CACHE_TTL_MINUTES,
  WEB_SEARCH_DEFAULT_COUNT,
  WEB_SEARCH_FALLBACK_PROVIDERS,
  WEB_SEARCH_PROVIDER,
  WEB_SEARCH_TAVILY_SEARCH_DEPTH,
} from '../config/config.js';
import { resolveWorkerRuntimeToken } from '../security/agent-runtime-token.js';
import { IDLE_TIMEOUT_MS } from './warm-runner-utils.js';
import { resolveWebSearchRuntimeConfig } from './web-search-runtime-config.js';

export function buildWorkerEnv(params: {
  agentId: string;
  runtimeScope: ExecutorRequest['runtimeScope'];
  displayRoot?: string;
  mode: 'container' | 'host';
  mapHostUrl: (url: string) => string;
}): Record<string, string> {
  return {
    HYBRIDCLAW_AGENT_ID: params.agentId,
    HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT:
      params.displayRoot?.trim() || '/workspace',
    HYBRIDCLAW_GATEWAY_URL: params.mapHostUrl(GATEWAY_CLIENT_BASE_URL),
    HYBRIDCLAW_GATEWAY_TOKEN: resolveWorkerRuntimeToken(params.runtimeScope),
    HYBRIDAI_BASE_URL,
    HYBRIDAI_MODEL,
    CONTAINER_IDLE_TIMEOUT: String(IDLE_TIMEOUT_MS),
    HYBRIDCLAW_RETRY_ENABLED: PROACTIVE_AUTO_RETRY_ENABLED ? 'true' : 'false',
    HYBRIDCLAW_RETRY_MAX_ATTEMPTS: String(PROACTIVE_AUTO_RETRY_MAX_ATTEMPTS),
    HYBRIDCLAW_RETRY_BASE_DELAY_MS: String(PROACTIVE_AUTO_RETRY_BASE_DELAY_MS),
    HYBRIDCLAW_RETRY_MAX_DELAY_MS: String(PROACTIVE_AUTO_RETRY_MAX_DELAY_MS),
    HYBRIDCLAW_RALPH_MAX_ITERATIONS: String(PROACTIVE_RALPH_MAX_ITERATIONS),
    BROWSER_ALLOW_PRIVATE_NETWORK: BROWSER_ALLOW_PRIVATE_NETWORK
      ? 'true'
      : 'false',
    HYBRIDCLAW_WEB_SEARCH_PROVIDER: WEB_SEARCH_PROVIDER,
    HYBRIDCLAW_WEB_SEARCH_FALLBACK_PROVIDERS:
      WEB_SEARCH_FALLBACK_PROVIDERS.join(','),
    HYBRIDCLAW_WEB_SEARCH_DEFAULT_COUNT: String(WEB_SEARCH_DEFAULT_COUNT),
    HYBRIDCLAW_WEB_SEARCH_CACHE_TTL_MINUTES: String(
      WEB_SEARCH_CACHE_TTL_MINUTES,
    ),
    HYBRIDCLAW_WEB_SEARCH_TAVILY_SEARCH_DEPTH: WEB_SEARCH_TAVILY_SEARCH_DEPTH,
    SEARXNG_BASE_URL: resolveWebSearchRuntimeConfig(params.agentId)
      .searxngBaseUrl,
    HYBRIDCLAW_AGENT_SANDBOX_MODE: params.mode,
  };
}
