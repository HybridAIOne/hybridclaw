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
