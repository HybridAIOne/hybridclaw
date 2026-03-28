import {
  HUGGINGFACE_ENABLED,
  HYBRIDAI_ENABLE_RAG,
  HYBRIDAI_MODEL,
  LOCAL_LMSTUDIO_ENABLED,
  LOCAL_OLLAMA_ENABLED,
  LOCAL_VLLM_ENABLED,
  OPENROUTER_ENABLED,
} from '../config/config.js';
import { anthropicProvider } from './anthropic.js';
import { huggingfaceProvider } from './huggingface.js';
import { hybridAIProvider } from './hybridai.js';
import { ollamaProvider } from './local-ollama.js';
import { lmstudioProvider, vllmProvider } from './local-openai-compat.js';
import { openAIProvider } from './openai.js';
import { openrouterProvider } from './openrouter.js';
import type {
  AIProvider,
  AIProviderId,
  ResolvedModelRuntimeCredentials,
  ResolveProviderRuntimeParams,
} from './types.js';

function getActiveProviders(): AIProvider[] {
  return [
    openAIProvider,
    anthropicProvider,
    ...(OPENROUTER_ENABLED ? [openrouterProvider] : []),
    ...(HUGGINGFACE_ENABLED ? [huggingfaceProvider] : []),
    ...(LOCAL_OLLAMA_ENABLED ? [ollamaProvider] : []),
    ...(LOCAL_LMSTUDIO_ENABLED ? [lmstudioProvider] : []),
    ...(LOCAL_VLLM_ENABLED ? [vllmProvider] : []),
    hybridAIProvider,
  ];
}

export function resolveProviderForModel(model: string): AIProvider {
  const normalizedModel = String(model || '').trim();
  return (
    getActiveProviders().find((provider) =>
      provider.matchesModel(normalizedModel),
    ) || hybridAIProvider
  );
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
