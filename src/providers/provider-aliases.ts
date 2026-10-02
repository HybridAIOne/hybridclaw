/**
 * Provider aliases — vendor and brand names users type for a runtime provider
 * (`grok` → `xai`, `qwen` → `dashscope`).
 *
 * Supported product API for `/model list <provider>`, `/second-opinion
 * --provider`, and every model-provider `hybridclaw auth` target
 * (`src/auth/auth-targets.ts`), not backward-compatibility shims: they carry
 * no `compat:` marker and are not retired by release cleanup.
 */
import type { RuntimeProviderId } from './provider-ids.js';

// `google` is deliberately absent (owner call, 2026-10-02): it names the
// Google Workspace auth target (src/auth/auth-targets.ts), so it no longer
// also means `gemini` here. Use `gemini` or `google-gemini`.
export const PROVIDER_ALIASES: Readonly<Record<string, RuntimeProviderId>> = {
  'hybrid-ai': 'hybridai',
  hybrid: 'hybridai',
  codex: 'openai-codex',
  claude: 'anthropic',
  or: 'openrouter',
  hf: 'huggingface',
  'hugging-face': 'huggingface',
  'huggingface-hub': 'huggingface',
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
