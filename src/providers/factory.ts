import { HYBRIDAI_ENABLE_RAG, HYBRIDAI_MODEL } from '../config/config.js';
import { anthropicProvider } from './anthropic.js';
import { hybridAIProvider } from './hybridai.js';
import { openAIProvider } from './openai.js';
import type {
  AIProvider,
  AIProviderId,
  ResolveProviderRuntimeParams,
  ResolvedModelRuntimeCredentials,
} from './types.js';

const PROVIDERS: AIProvider[] = [
  openAIProvider,
  anthropicProvider,
  hybridAIProvider,
];

export function getAIProviders(): readonly AIProvider[] {
  return PROVIDERS;
}

export function resolveProviderForModel(model: string): AIProvider {
  const normalizedModel = String(model || '').trim();
  return (
    PROVIDERS.find((provider) => provider.matchesModel(normalizedModel)) ||
    hybridAIProvider
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

export function resolveAgentIdForModel(
  model: string,
  chatbotId: string,
): string {
  return resolveProviderForModel(model).resolveAgentId(model, chatbotId);
}

export async function resolveModelRuntimeCredentials(
  params?: ResolveProviderRuntimeParams,
): Promise<ResolvedModelRuntimeCredentials> {
  const model = String(params?.model || HYBRIDAI_MODEL).trim() || HYBRIDAI_MODEL;
  const provider = resolveProviderForModel(model);
  return provider.resolveRuntimeCredentials({
    model,
    chatbotId: params?.chatbotId,
    enableRag: params?.enableRag ?? HYBRIDAI_ENABLE_RAG,
  });
}
