import type { ChatCompletionResponse } from './types.js';
import {
  callHybridAIProvider,
  callHybridAIProviderStream,
} from './providers/hybridai.js';
import {
  callOpenAICodexProvider,
  callOpenAICodexProviderStream,
} from './providers/openai-codex.js';
import {
  HybridAIRequestError,
  normalizeCallArgs,
  normalizeStreamCallArgs,
} from './providers/shared.js';

export { HybridAIRequestError } from './providers/shared.js';

/**
 * Compatibility entrypoint for the container runtime. Provider-specific request
 * building and stream parsing now live under `container/src/providers/`.
 */
export async function callHybridAI(
  ...rawArgs: unknown[]
): Promise<ChatCompletionResponse> {
  const args = normalizeCallArgs(rawArgs);
  if (args.provider === 'openai-codex') {
    return callOpenAICodexProvider(args);
  }
  return callHybridAIProvider(args);
}

/**
 * Compatibility entrypoint for streamed model calls. Concrete provider
 * transports are implemented in `container/src/providers/`.
 */
export async function callHybridAIStream(
  ...rawArgs: unknown[]
): Promise<ChatCompletionResponse> {
  const args = normalizeStreamCallArgs(rawArgs);
  if (args.provider === 'openai-codex') {
    return callOpenAICodexProviderStream(args);
  }
  return callHybridAIProviderStream(args);
}
