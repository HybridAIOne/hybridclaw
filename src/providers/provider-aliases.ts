/**
 * Provider aliases — vendor and brand names users type for a runtime provider
 * (`grok` → `xai`, `qwen` → `dashscope`).
 *
 * Supported product API for `/model list <provider>` and the generic
 * `auth login <provider>` providers, not backward-compatibility shims: they
 * carry no `compat:` marker and are not retired by release cleanup.
 */
import type { RuntimeProviderId } from './provider-ids.js';

export const PROVIDER_ALIASES: Readonly<Record<string, RuntimeProviderId>> = {
  codex: 'openai-codex',
  google: 'gemini',
  'google-gemini': 'gemini',
  'deep-seek': 'deepseek',
  grok: 'xai',
  'x-ai': 'xai',
  'z-ai': 'zai',
  glm: 'zai',
  zhipu: 'zai',
  moonshot: 'kimi',
  'kimi-coding': 'kimi',
  'mini-max': 'minimax',
  qwen: 'dashscope',
  alibaba: 'dashscope',
  mimo: 'xiaomi',
  kilocode: 'kilo',
  'kilo-code': 'kilo',
};

export function getProviderAliasesFor(id: RuntimeProviderId): string[] {
  return Object.entries(PROVIDER_ALIASES)
    .filter(([, canonical]) => canonical === id)
    .map(([alias]) => alias);
}
