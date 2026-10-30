/**
 * Model resolution rejects unknown providers before credentials or requests are used.
 * Startup may handle UnknownModelProviderError to keep configuration accessible;
 * this factory never substitutes a provider for an unknown model prefix.
 */
import { HYBRIDAI_ENABLE_RAG, HYBRIDAI_MODEL } from '../config/config.js';
import { getRuntimeConfig } from '../config/runtime-config.js';
import { anthropicProvider } from './anthropic.js';
import { huggingfaceProvider } from './huggingface.js';
import { hybridAIProvider } from './hybridai.js';
import { getLocalModelInfo } from './local-discovery.js';
import { resolveLocalBackendFromEndpointModel } from './local-endpoints.js';
import { ollamaProvider } from './local-ollama.js';
import {
  llamacppProvider,
  lmstudioProvider,
  mlxProvider,
  vllmProvider,
} from './local-openai-compat.js';
import { mistralProvider } from './mistral.js';
import { openAIAPIProvider, openAIProvider } from './openai.js';
import { getOpenAICompatRemoteProvider } from './openai-compat-remote.js';
import { openrouterProvider } from './openrouter.js';
import {
  isLocalBackendType,
  isOpenAICompatRemoteProviderId,
} from './provider-ids.js';
import type {
  AIProvider,
  ResolvedModelRuntimeCredentials,
  ResolveProviderRuntimeParams,
  RuntimeProviderId,
} from './types.js';

const KNOWN_PROVIDER_BY_ID: ReadonlyMap<RuntimeProviderId, AIProvider> =
  new Map(
    Object.entries({
      hybridai: hybridAIProvider,
      openai: openAIAPIProvider,
      'openai-codex': openAIProvider,
      anthropic: anthropicProvider,
      openrouter: openrouterProvider,
      mistral: mistralProvider,
      huggingface: huggingfaceProvider,
      gemini: getOpenAICompatRemoteProvider('gemini'),
      deepseek: getOpenAICompatRemoteProvider('deepseek'),
      xai: getOpenAICompatRemoteProvider('xai'),
      zai: getOpenAICompatRemoteProvider('zai'),
      kimi: getOpenAICompatRemoteProvider('kimi'),
      minimax: getOpenAICompatRemoteProvider('minimax'),
      dashscope: getOpenAICompatRemoteProvider('dashscope'),
      xiaomi: getOpenAICompatRemoteProvider('xiaomi'),
      kilo: getOpenAICompatRemoteProvider('kilo'),
      ollama: ollamaProvider,
      lmstudio: lmstudioProvider,
      llamacpp: llamacppProvider,
      vllm: vllmProvider,
      mlx: mlxProvider,
    } satisfies Record<RuntimeProviderId, AIProvider>) as Array<
      [RuntimeProviderId, AIProvider]
    >,
  );

function isProviderEnabledAtStartup(id: RuntimeProviderId): boolean {
  const config = getRuntimeConfig();
  if (id === 'openai' || isOpenAICompatRemoteProviderId(id)) {
    return config[id].enabled;
  }
  if (isLocalBackendType(id) && id !== 'mlx') {
    return config.local.backends[id].enabled;
  }
  return true;
}

const PROVIDER_BY_MODEL_PREFIX = new Map<string, AIProvider>(
  [...KNOWN_PROVIDER_BY_ID].filter(([id]) => isProviderEnabledAtStartup(id)),
);

function normalizeModel(model: string): string {
  return String(model || '').trim();
}

function getModelPrefix(model: string): string | null {
  const slashIndex = model.indexOf('/');
  if (slashIndex < 0) return null;
  return model.slice(0, slashIndex).toLowerCase();
}

export class UnknownModelProviderError extends Error {
  override name = 'UnknownModelProviderError';
}

function resolvePrefixedProvider(model: string, prefix: string): AIProvider {
  const provider = PROVIDER_BY_MODEL_PREFIX.get(prefix);
  if (provider) return provider;

  const endpointBackend = resolveLocalBackendFromEndpointModel(model);
  if (endpointBackend) {
    const endpointProvider = KNOWN_PROVIDER_BY_ID.get(endpointBackend);
    if (endpointProvider) return endpointProvider;
  }

  if (KNOWN_PROVIDER_BY_ID.has(prefix as RuntimeProviderId))
    return hybridAIProvider;

  throw new UnknownModelProviderError(
    `Unknown provider prefix \`${prefix}\` in model \`${model}\`.`,
  );
}

function resolveBareModelProvider(model: string): AIProvider {
  const endpointBackend = resolveLocalBackendFromEndpointModel(model);
  if (endpointBackend) {
    const provider = KNOWN_PROVIDER_BY_ID.get(endpointBackend);
    if (provider) return provider;
  }
  const localBackend = getLocalModelInfo(model)?.backend;
  if (localBackend) {
    const provider = KNOWN_PROVIDER_BY_ID.get(localBackend);
    if (provider) return provider;
    throw new UnknownModelProviderError(
      `Unknown local model backend \`${localBackend}\` for model \`${model}\`.`,
    );
  }
  return hybridAIProvider;
}

export function resolveProviderForModel(model: string): AIProvider {
  const normalizedModel = normalizeModel(model);
  const prefix = getModelPrefix(normalizedModel);
  if (prefix) return resolvePrefixedProvider(normalizedModel, prefix);
  return resolveBareModelProvider(normalizedModel);
}

export function resolveModelProvider(model: string): RuntimeProviderId {
  return resolveProviderForModel(model).id;
}

export function isProviderModel(
  model: string,
  providerId: RuntimeProviderId,
): boolean {
  return resolveModelProvider(model) === providerId;
}

export function isCodexModel(model: string): boolean {
  return isProviderModel(model, 'openai-codex');
}

export async function resolveModelRuntimeCredentials(
  params?: ResolveProviderRuntimeParams,
): Promise<ResolvedModelRuntimeCredentials> {
  const model =
    String(params?.model || HYBRIDAI_MODEL).trim() || HYBRIDAI_MODEL;
  const provider = resolveProviderForModel(model);
  const resolved = await provider.resolveRuntimeCredentials({
    model,
    chatbotId: params?.chatbotId,
    enableRag: params?.enableRag ?? HYBRIDAI_ENABLE_RAG,
    agentId: params?.agentId,
  });
  return resolved;
}
