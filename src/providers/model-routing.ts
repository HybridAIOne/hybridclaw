import { createHash } from 'node:crypto';

import { MissingRequiredEnvVarError } from '../config/config.js';
import { getRuntimeConfig } from '../config/runtime-config.js';
import { logger } from '../logger.js';
import { readStoredRuntimeSecrets } from '../security/runtime-secrets.js';
import { resolveModelRuntimeCredentials } from './factory.js';
import { resolveProviderRequestMaxTokens } from './request-max-tokens.js';
import type {
  ResolvedCredentialPool,
  ResolvedCredentialPoolEntry,
  ResolvedModelRoutingPlan,
  ResolvedModelRuntimeRoute,
  ResolveProviderRuntimeParams,
  RuntimeProviderId,
} from './types.js';

const PROVIDER_POOL_SECRET_NAMES: Partial<Record<RuntimeProviderId, string>> = {
  hybridai: 'HYBRIDAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  huggingface: 'HF_TOKEN',
  gemini: 'GEMINI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  xai: 'XAI_API_KEY',
  zai: 'ZAI_API_KEY',
  kimi: 'KIMI_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  dashscope: 'DASHSCOPE_API_KEY',
  xiaomi: 'XIAOMI_API_KEY',
  kilo: 'KILO_API_KEY',
  vllm: 'VLLM_API_KEY',
};

type SecretCatalog = Record<string, string | undefined>;

interface DiscoveredSecretValue {
  label: string;
  value: string;
}

function createCredentialEntryId(
  provider: RuntimeProviderId,
  value: string,
): string {
  return createHash('sha256')
    .update(`${provider}:${value}`, 'utf-8')
    .digest('hex')
    .slice(0, 16);
}

function normalizePoolListSecretNames(baseName: string): string[] {
  if (baseName.endsWith('_API_KEY')) {
    return [baseName.replace(/_API_KEY$/, '_API_KEYS'), `${baseName}_POOL`];
  }
  if (baseName.endsWith('_TOKEN')) {
    return [baseName.replace(/_TOKEN$/, '_TOKENS'), `${baseName}_POOL`];
  }
  return [`${baseName}_POOL`];
}

function parseSecretList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function collectIndexedSecretNames(
  baseName: string,
  source: SecretCatalog,
): string[] {
  const indexed = Object.keys(source)
    .filter((key) => new RegExp(`^${baseName}_(\\d+)$`).test(key))
    .sort((left, right) => {
      const leftIndex = Number(left.slice(baseName.length + 1));
      const rightIndex = Number(right.slice(baseName.length + 1));
      return leftIndex - rightIndex;
    });
  return indexed;
}

function addDiscoveredSecret(
  collection: DiscoveredSecretValue[],
  seen: Set<string>,
  label: string,
  value: string | undefined,
): void {
  const normalized = String(value || '').trim();
  if (!normalized || seen.has(normalized)) return;
  seen.add(normalized);
  collection.push({ label, value: normalized });
}

function discoverProviderSecretValues(
  baseName: string,
): DiscoveredSecretValue[] {
  const storedSecrets = readStoredRuntimeSecrets();
  const discovered: DiscoveredSecretValue[] = [];
  const seen = new Set<string>();
  const listSecretNames = normalizePoolListSecretNames(baseName);

  addDiscoveredSecret(discovered, seen, baseName, process.env[baseName]);
  addDiscoveredSecret(discovered, seen, baseName, storedSecrets[baseName]);

  for (const listName of listSecretNames) {
    const envValues = parseSecretList(process.env[listName] || '');
    for (const [index, value] of envValues.entries()) {
      addDiscoveredSecret(discovered, seen, `${listName}[${index + 1}]`, value);
    }

    const storedValues = parseSecretList(storedSecrets[listName] || '');
    for (const [index, value] of storedValues.entries()) {
      addDiscoveredSecret(discovered, seen, `${listName}[${index + 1}]`, value);
    }
  }

  for (const indexedName of collectIndexedSecretNames(baseName, process.env)) {
    addDiscoveredSecret(
      discovered,
      seen,
      indexedName,
      process.env[indexedName],
    );
  }
  for (const indexedName of collectIndexedSecretNames(
    baseName,
    storedSecrets,
  )) {
    addDiscoveredSecret(
      discovered,
      seen,
      indexedName,
      storedSecrets[indexedName],
    );
  }

  return discovered;
}

export function resolveProviderCredentialPool(
  provider: RuntimeProviderId,
  primaryApiKey?: string,
): ResolvedCredentialPool | undefined {
  const baseSecretName = PROVIDER_POOL_SECRET_NAMES[provider];
  const seen = new Set<string>();
  const entries: ResolvedCredentialPoolEntry[] = [];

  const addEntry = (label: string, value: string | undefined) => {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    entries.push({
      id: createCredentialEntryId(provider, normalized),
      label,
      apiKey: normalized,
    });
  };

  addEntry('active', primaryApiKey);

  if (baseSecretName) {
    for (const discovered of discoverProviderSecretValues(baseSecretName)) {
      addEntry(discovered.label, discovered.value);
    }
  }

  return entries.length > 0
    ? {
        rotation: 'least_used',
        entries,
      }
    : undefined;
}

function normalizeModelRouteChain(
  primaryModel: string,
  fallbackModels: string[],
): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  for (const entry of [primaryModel, ...fallbackModels]) {
    const normalized = String(entry || '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    chain.push(normalized);
  }
  return chain;
}

async function resolveRoute(
  params: ResolveProviderRuntimeParams & { model: string },
): Promise<ResolvedModelRuntimeRoute> {
  const resolved = await resolveModelRuntimeCredentials(params);
  return {
    ...resolved,
    model: params.model,
    maxTokens: resolveProviderRequestMaxTokens({
      model: params.model,
      discoveredMaxTokens: resolved.maxTokens,
    }),
    credentialPool: resolveProviderCredentialPool(
      resolved.provider,
      resolved.apiKey,
    ),
  };
}

export async function resolvePrimaryModelRoutingPlan(
  params: ResolveProviderRuntimeParams,
): Promise<ResolvedModelRoutingPlan> {
  const config = getRuntimeConfig();
  const primaryModel =
    String(params.model || config.hybridai.defaultModel).trim() ||
    config.hybridai.defaultModel;
  const routeModels = normalizeModelRouteChain(
    primaryModel,
    config.routing.primaryModel.fallbackModels,
  );
  const routes: ResolvedModelRuntimeRoute[] = [];

  for (const [index, model] of routeModels.entries()) {
    try {
      routes.push(
        await resolveRoute({
          ...params,
          model,
        }),
      );
    } catch (error) {
      if (index === 0 || error instanceof MissingRequiredEnvVarError) {
        if (index === 0) throw error;
        logger.warn(
          {
            model,
            error: error instanceof Error ? error.message : String(error),
          },
          'Skipping primary-model fallback route because credentials are unavailable',
        );
        continue;
      }

      logger.warn(
        {
          model,
          error: error instanceof Error ? error.message : String(error),
        },
        'Skipping primary-model fallback route because it could not be resolved',
      );
    }
  }

  return {
    routes,
    adaptiveContextTierDowngradeOn429:
      config.routing.primaryModel.adaptiveContextTierDowngradeOn429,
  };
}
