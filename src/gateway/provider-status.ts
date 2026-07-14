import fs from 'node:fs';

import {
  getAnthropicAuthStatus,
  isAnthropicAuthReadyForMethod,
} from '../auth/anthropic-auth.js';
import { getCodexAuthStatus } from '../auth/codex-auth.js';
import { getRuntimeConfig } from '../config/runtime-config.js';
import { getDiscoveredCodexModelNames } from '../providers/codex-discovery.js';
import { getDiscoveredHuggingFaceModelNames } from '../providers/huggingface-discovery.js';
import { getDiscoveredMistralModelNames } from '../providers/mistral-discovery.js';
import { readApiKeyForOpenAICompatProvider } from '../providers/openai-compat-remote.js';
import { getDiscoveredOpenRouterModelNames } from '../providers/openrouter-discovery.js';
import { dedupeStrings } from '../utils/normalized-strings.js';
import {
  buildGatewayHybridAIProviderEntry,
  type GatewayHealthOptions,
  resolveGatewayHybridAIHealth,
  resolveGatewayLocalBackendsHealth,
} from './gateway-health-service.js';
import { diagnoseProviderForModels } from './gateway-provider-service.js';
import type { GatewayStatus } from './gateway-types.js';

export function buildGatewayProviderHealth(params: {
  localBackends: GatewayStatus['localBackends'];
  codex: ReturnType<typeof getCodexAuthStatus>;
  hybridaiHealth: NonNullable<GatewayStatus['providerHealth']>['hybridai'];
}): NonNullable<GatewayStatus['providerHealth']> {
  const runtimeConfig = getRuntimeConfig();
  const anthropicStatus = getAnthropicAuthStatus();
  const anthropicReady = isAnthropicAuthReadyForMethod(
    anthropicStatus,
    runtimeConfig.anthropic.method,
  );
  const codexConfigured =
    params.codex.authenticated ||
    fs.existsSync(params.codex.path) ||
    runtimeConfig.hybridai.defaultModel
      .trim()
      .toLowerCase()
      .startsWith('openai-codex/');
  const providerHealth: NonNullable<GatewayStatus['providerHealth']> = {
    hybridai: params.hybridaiHealth,
  };
  if (codexConfigured) {
    providerHealth.codex = {
      kind: 'remote',
      reachable: params.codex.authenticated && !params.codex.reloginRequired,
      ...(params.codex.authenticated && !params.codex.reloginRequired
        ? {}
        : {
            error: params.codex.reloginRequired
              ? 'Login required'
              : 'Not authenticated',
          }),
      ...(params.codex.reloginRequired ? { loginRequired: true } : {}),
      modelCount: dedupeStrings(getDiscoveredCodexModelNames()).length,
      detail:
        params.codex.authenticated && !params.codex.reloginRequired
          ? `Authenticated${params.codex.source ? ` via ${params.codex.source}` : ''}`
          : params.codex.reloginRequired
            ? 'Login required'
            : 'Not authenticated',
    };
  }
  if (runtimeConfig.anthropic.enabled || anthropicStatus.authenticated) {
    providerHealth.anthropic = {
      kind: 'remote',
      reachable: anthropicReady,
      ...(anthropicReady ? {} : { error: 'Not authenticated' }),
      modelCount: dedupeStrings(runtimeConfig.anthropic.models).length,
      detail: anthropicReady
        ? `Authenticated${anthropicStatus.source ? ` via ${anthropicStatus.source}` : ''}`
        : anthropicStatus.authenticated && anthropicStatus.method
          ? `Detected ${anthropicStatus.method}, configured ${runtimeConfig.anthropic.method}`
          : 'Not authenticated',
    };
  }
  const optionalRemoteProviders = [
    {
      key: 'openrouter',
      enabled: runtimeConfig.openrouter.enabled,
      authenticated: Boolean(
        readApiKeyForOpenAICompatProvider('openrouter', { required: false }),
      ),
      modelCount: dedupeStrings(getDiscoveredOpenRouterModelNames()).length,
    },
    {
      key: 'mistral',
      enabled: runtimeConfig.mistral.enabled,
      authenticated: Boolean(
        readApiKeyForOpenAICompatProvider('mistral', { required: false }),
      ),
      modelCount: dedupeStrings(getDiscoveredMistralModelNames()).length,
    },
    {
      key: 'huggingface',
      enabled: runtimeConfig.huggingface.enabled,
      authenticated: Boolean(
        readApiKeyForOpenAICompatProvider('huggingface', { required: false }),
      ),
      modelCount: dedupeStrings(getDiscoveredHuggingFaceModelNames()).length,
    },
  ] as const;

  for (const provider of optionalRemoteProviders) {
    if (!provider.enabled) continue;
    providerHealth[provider.key] = {
      kind: 'remote',
      reachable: provider.authenticated,
      ...(provider.authenticated ? {} : { error: 'Not authenticated' }),
      modelCount: provider.modelCount,
      detail: provider.authenticated ? 'Authenticated' : 'Not authenticated',
    };
  }

  for (const [name, status] of Object.entries(params.localBackends || {})) {
    providerHealth[name as keyof typeof providerHealth] = {
      kind: 'local',
      reachable: status.reachable,
      latencyMs: status.latencyMs,
      ...(status.error ? { error: status.error } : {}),
      ...(typeof status.modelCount === 'number'
        ? { modelCount: status.modelCount }
        : {}),
      detail: status.reachable
        ? `${status.latencyMs}ms`
        : status.error || 'unreachable',
    };
  }

  return providerHealth;
}

export async function getGatewayAdminProviderStatus(
  options: GatewayHealthOptions = {},
): Promise<NonNullable<GatewayStatus['providerHealth']>> {
  const codex = getCodexAuthStatus();
  const [localBackendsResult, hybridaiResult] = await Promise.allSettled([
    resolveGatewayLocalBackendsHealth(options),
    resolveGatewayHybridAIHealth(options),
  ]);
  const localBackendsMap =
    localBackendsResult.status === 'fulfilled'
      ? localBackendsResult.value
      : new Map();
  const localBackends = Object.fromEntries(
    [...localBackendsMap.entries()].map(([backend, status]) => [
      backend,
      {
        reachable: status.reachable,
        latencyMs: status.latencyMs,
        ...(status.error ? { error: status.error } : {}),
        ...(typeof status.modelCount === 'number'
          ? { modelCount: status.modelCount }
          : {}),
      },
    ]),
  ) as GatewayStatus['localBackends'];
  const hybridaiHealth = buildGatewayHybridAIProviderEntry(
    hybridaiResult.status === 'fulfilled'
      ? hybridaiResult.value
      : {
          reachable: false,
          error: 'probe failed',
          latencyMs: 0,
        },
  );
  const providerStatus = Object.fromEntries(
    Object.entries(
      buildGatewayProviderHealth({
        localBackends,
        codex,
        hybridaiHealth,
      }),
    ).map(([name, value]) => [name, { ...value }]),
  ) as NonNullable<GatewayStatus['providerHealth']>;
  const remoteOpenAiCompatKeys = [
    'openrouter',
    'mistral',
    'huggingface',
    'gemini',
    'deepseek',
    'xai',
    'zai',
    'kimi',
    'minimax',
    'dashscope',
    'xiaomi',
    'kilo',
  ] as const;
  for (const key of remoteOpenAiCompatKeys) {
    if (providerStatus[key]) continue;
    const diagnostic = diagnoseProviderForModels(key, providerStatus);
    providerStatus[key] = {
      kind: 'remote',
      reachable: diagnostic === null,
      ...(diagnostic
        ? {
            error: diagnostic.message,
            loginRequired: diagnostic.kind === 'unauthorized',
          }
        : {}),
    };
  }
  return providerStatus;
}
