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
  vllmProvider,
} from './local-openai-compat.js';
import { mistralProvider } from './mistral.js';
import { openAIAPIProvider, openAIProvider } from './openai.js';
import {
  dashscopeProvider,
  deepseekProvider,
  geminiProvider,
  kiloProvider,
  kimiProvider,
  minimaxProvider,
  xaiProvider,
  xiaomiProvider,
  zaiProvider,
} from './openai-compat-remote.js';
import { openrouterProvider } from './openrouter.js';
import type {
  AIProvider,
  AIProviderId,
  ResolvedModelRuntimeCredentials,
  ResolveProviderRuntimeParams,
} from './types.js';

const KNOWN_PROVIDERS: AIProvider[] = [
  openAIAPIProvider,
  openAIProvider,
  anthropicProvider,
  openrouterProvider,
  mistralProvider,
  huggingfaceProvider,
  geminiProvider,
  deepseekProvider,
  xaiProvider,
  zaiProvider,
  kimiProvider,
  minimaxProvider,
  dashscopeProvider,
  xiaomiProvider,
  kiloProvider,
  ollamaProvider,
  lmstudioProvider,
  llamacppProvider,
  vllmProvider,
  hybridAIProvider,
];

const KNOWN_PROVIDER_BY_ID = new Map<AIProviderId, AIProvider>(
  KNOWN_PROVIDERS.map((provider) => [provider.id, provider]),
);

const runtimeConfig = getRuntimeConfig();
const ACTIVE_PROVIDERS: AIProvider[] = [
  ...(runtimeConfig.openai.enabled ? [openAIAPIProvider] : []),
  openAIProvider,
  anthropicProvider,
  ...(runtimeConfig.openrouter.enabled ? [openrouterProvider] : []),
  ...(runtimeConfig.mistral.enabled ? [mistralProvider] : []),
  ...(runtimeConfig.huggingface.enabled ? [huggingfaceProvider] : []),
  ...(runtimeConfig.gemini.enabled ? [geminiProvider] : []),
  ...(runtimeConfig.deepseek.enabled ? [deepseekProvider] : []),
  ...(runtimeConfig.xai.enabled ? [xaiProvider] : []),
  ...(runtimeConfig.zai.enabled ? [zaiProvider] : []),
  ...(runtimeConfig.kimi.enabled ? [kimiProvider] : []),
  ...(runtimeConfig.minimax.enabled ? [minimaxProvider] : []),
  ...(runtimeConfig.dashscope.enabled ? [dashscopeProvider] : []),
  ...(runtimeConfig.xiaomi.enabled ? [xiaomiProvider] : []),
  ...(runtimeConfig.kilo.enabled ? [kiloProvider] : []),
  ...(runtimeConfig.local.backends.ollama.enabled ? [ollamaProvider] : []),
  ...(runtimeConfig.local.backends.lmstudio.enabled ? [lmstudioProvider] : []),
  ...(runtimeConfig.local.backends.llamacpp.enabled ? [llamacppProvider] : []),
  ...(runtimeConfig.local.backends.vllm.enabled ? [vllmProvider] : []),
  hybridAIProvider,
];

const PROVIDER_BY_MODEL_PREFIX = new Map<string, AIProvider>(
  ACTIVE_PROVIDERS.map((provider) => [provider.id, provider]),
);

function normalizeModel(model: string): string {
  return String(model || '').trim();
}

function getModelPrefix(model: string): string | null {
  const slashIndex = model.indexOf('/');
  if (slashIndex < 0) return null;
  return model.slice(0, slashIndex).toLowerCase();
}

function resolvePrefixedProvider(model: string, prefix: string): AIProvider {
  const provider = PROVIDER_BY_MODEL_PREFIX.get(prefix);
  if (provider) return provider;

  const endpointBackend = resolveLocalBackendFromEndpointModel(model);
  if (endpointBackend) {
    const endpointProvider = KNOWN_PROVIDER_BY_ID.get(endpointBackend);
    if (endpointProvider) return endpointProvider;
  }

  if (KNOWN_PROVIDER_BY_ID.has(prefix as AIProviderId)) return hybridAIProvider;

  throw new Error(
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
    throw new Error(
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

export function resolveModelProvider(model: string): AIProviderId {
  return resolveProviderForModel(model).id;
}

export function isProviderModel(
  model: string,
  providerId: AIProviderId,
): boolean {
  return resolveModelProvider(model) === providerId;
}

export function isCodexModel(model: string): boolean {
  return isProviderModel(model, 'openai-codex');
}

export function modelRequiresChatbotId(model: string): boolean {
  return resolveProviderForModel(model).requiresChatbotId(model);
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
