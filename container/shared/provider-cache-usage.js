/**
 * Provider cache counters preserve an explicit zero and leave absent data unknown.
 * Unlike token pricing, this reader only normalizes reported aliases; it never
 * derives cache hits from prompt totals or adds aliases for the same counter.
 */
import { isRecord, parseNonNegativeInteger } from './primitive-values.js';

function firstCounter(values) {
  for (const value of values) {
    const parsed = parseNonNegativeInteger(value);
    if (parsed !== null) return parsed;
  }
  return undefined;
}

export function readProviderCacheUsage(value) {
  if (!isRecord(value)) return {};
  const prompt = isRecord(value.prompt_tokens_details)
    ? value.prompt_tokens_details
    : {};
  const input = isRecord(value.input_tokens_details)
    ? value.input_tokens_details
    : {};
  // Normalized counters take precedence, then nested API details, then aliases.
  const cacheReadTokens = firstCounter([
    value.cacheRead,
    value.cache_read,
    value.cacheReadTokens,
    value.cacheReadInputTokens,
    prompt.cached_tokens,
    input.cached_tokens,
    value.cache_read_tokens,
    value.cache_read_input_tokens,
    value.cached_tokens,
    value.prompt_cache_hit_tokens,
  ]);
  const cacheWriteTokens = firstCounter([
    value.cacheWrite,
    value.cache_write,
    value.cacheWriteTokens,
    value.cacheWriteInputTokens,
    prompt.cache_write_tokens,
    input.cache_write_tokens,
    value.cache_write_tokens,
    value.cache_write_input_tokens,
    value.cache_creation_input_tokens,
  ]);
  return {
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
  };
}
