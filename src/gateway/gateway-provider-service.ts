import {
  getAnthropicAuthStatus,
  isAnthropicAuthReadyForMethod,
} from '../auth/anthropic-auth.js';
import { getCodexAuthStatus } from '../auth/codex-auth.js';
import { getHybridAIAuthStatus } from '../auth/hybridai-auth.js';
import { getRuntimeConfig } from '../config/runtime-config.js';
import type { ModelCatalogProviderFilter } from '../providers/model-catalog.js';
import { getOpenAICompatProviderLastError } from '../providers/openai-compat-discovery.js';
import { readApiKeyForOpenAICompatProvider } from '../providers/openai-compat-remote.js';
import type { GatewayStatus } from './gateway-types.js';

export type ProviderDiagnosticKind =
  | 'disabled'
  | 'unauthorized'
  | 'unreachable';

export interface ProviderDiagnostic {
  kind: ProviderDiagnosticKind;
  message: string;
}

interface ProviderMeta {
  label: string;
  loginName: string | null;
}

const PROVIDER_META: Record<
  Exclude<ModelCatalogProviderFilter, 'local'>,
  ProviderMeta
> = {
  hybridai: { label: 'HybridAI', loginName: 'hybridai' },
  'openai-codex': { label: 'Codex', loginName: 'codex' },
  anthropic: { label: 'Anthropic', loginName: 'anthropic' },
  openrouter: { label: 'OpenRouter', loginName: 'openrouter' },
  mistral: { label: 'Mistral', loginName: 'mistral' },
  huggingface: { label: 'Hugging Face', loginName: 'huggingface' },
  gemini: { label: 'Google Gemini', loginName: 'gemini' },
  deepseek: { label: 'DeepSeek', loginName: 'deepseek' },
  xai: { label: 'xAI', loginName: 'xai' },
  zai: { label: 'Z.AI / GLM', loginName: 'zai' },
  kimi: { label: 'Kimi / Moonshot', loginName: 'kimi' },
  minimax: { label: 'MiniMax', loginName: 'minimax' },
  dashscope: { label: 'DashScope / Qwen', loginName: 'dashscope' },
  xiaomi: { label: 'Xiaomi MiMo', loginName: 'xiaomi' },
  kilo: { label: 'Kilo Code', loginName: 'kilo' },
  ollama: { label: 'Ollama', loginName: null },
  lmstudio: { label: 'LM Studio', loginName: null },
  llamacpp: { label: 'llama.cpp', loginName: null },
  vllm: { label: 'vLLM', loginName: null },
};

export function buildProviderEnableCommand(
  provider: Exclude<ModelCatalogProviderFilter, 'local'>,
): string {
  return `config set ${provider}.enabled true`;
}

function rerunFilter(
  filter: Exclude<ModelCatalogProviderFilter, 'local'>,
): string {
  return filter === 'openai-codex' ? 'codex' : filter;
}

function disabled(
  filter: Exclude<ModelCatalogProviderFilter, 'local'>,
  enableCommand: string,
): ProviderDiagnostic {
  const { label } = PROVIDER_META[filter];
  return {
    kind: 'disabled',
    message: [
      `${label} is disabled.`,
      'Enable it:',
      `  ${enableCommand}`,
      `Then rerun \`model list ${rerunFilter(filter)}\`.`,
    ].join('\n'),
  };
}

function unauthorized(
  filter: Exclude<ModelCatalogProviderFilter, 'local'>,
  reloginRequired = false,
): ProviderDiagnostic {
  const { label, loginName } = PROVIDER_META[filter];
  return {
    kind: 'unauthorized',
    message: [
      reloginRequired
        ? `${label} authorization expired.`
        : `${label} is not authorized.`,
      'Authorize it first from a terminal:',
      `  hybridclaw auth login ${loginName ?? filter}`,
      `Then rerun \`model list ${rerunFilter(filter)}\`.`,
    ].join('\n'),
  };
}

function unreachable(
  filter: Exclude<ModelCatalogProviderFilter, 'local'>,
  baseUrl: string | null,
  detail?: string,
): ProviderDiagnostic {
  const { label } = PROVIDER_META[filter];
  return {
    kind: 'unreachable',
    message: [
      baseUrl
        ? `${label} at ${baseUrl} is not reachable.`
        : `${label} is not reachable.`,
      ...(detail ? [`Last discovery error: ${detail}`] : []),
      'Check your network or the provider status, then rerun',
      `  \`model list ${rerunFilter(filter)}\`.`,
    ].join('\n'),
  };
}

export function diagnoseProviderForModels(
  filter: ModelCatalogProviderFilter,
  providerHealth: GatewayStatus['providerHealth'],
): ProviderDiagnostic | null {
  if (filter === 'local') return null;

  const config = getRuntimeConfig();

  switch (filter) {
    case 'hybridai': {
      if (!getHybridAIAuthStatus().authenticated) return unauthorized(filter);
      if (providerHealth?.hybridai?.reachable !== true) {
        return unreachable(filter, config.hybridai.baseUrl);
      }
      return null;
    }
    case 'openai-codex': {
      const status = getCodexAuthStatus();
      if (!status.authenticated || status.reloginRequired) {
        return unauthorized(filter, status.reloginRequired);
      }
      if (providerHealth?.codex?.reachable !== true) {
        return unreachable(filter, null);
      }
      return null;
    }
    case 'anthropic': {
      if (!config.anthropic.enabled) {
        return disabled(filter, buildProviderEnableCommand(filter));
      }
      const status = getAnthropicAuthStatus();
      if (!isAnthropicAuthReadyForMethod(status, config.anthropic.method)) {
        return unauthorized(filter);
      }
      if (providerHealth?.anthropic?.reachable !== true) {
        return unreachable(filter, config.anthropic.baseUrl);
      }
      return null;
    }
    case 'openrouter':
    case 'mistral':
    case 'huggingface':
    case 'gemini':
    case 'deepseek':
    case 'xai':
    case 'zai':
    case 'kimi':
    case 'minimax':
    case 'dashscope':
    case 'xiaomi':
    case 'kilo': {
      const section = (config as unknown as Record<string, unknown>)[filter] as
        | { enabled: boolean; baseUrl?: string }
        | undefined;
      if (!section?.enabled) {
        return disabled(filter, buildProviderEnableCommand(filter));
      }
      if (!readApiKeyForOpenAICompatProvider(filter, { required: false })) {
        return unauthorized(filter);
      }
      const lastError = getOpenAICompatProviderLastError(filter);
      if (lastError) {
        const status = lastError.httpStatus;
        if (
          status !== 404 &&
          status !== 405 &&
          status !== 401 &&
          status !== 403
        ) {
          return unreachable(
            filter,
            section.baseUrl ?? null,
            lastError.message,
          );
        }
      }
      return null;
    }
    case 'ollama':
    case 'lmstudio':
    case 'llamacpp':
    case 'vllm': {
      if (config.local.backends[filter]?.enabled !== true) {
        return disabled(
          filter,
          `config set local.backends.${filter}.enabled true`,
        );
      }
      if (providerHealth?.[filter]?.reachable !== true) {
        return unreachable(
          filter,
          config.local.backends[filter]?.baseUrl ?? null,
        );
      }
      return null;
    }
  }
}
