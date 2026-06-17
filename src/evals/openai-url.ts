export const DEFAULT_OPENAI_BASE_URL = 'http://127.0.0.1:9090/v1';

export function normalizeOpenAIBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return DEFAULT_OPENAI_BASE_URL;
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}
