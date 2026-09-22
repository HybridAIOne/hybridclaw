import { isRecord } from './utils.js';

export interface DiscoveredModelPricingUsdPerToken {
  input: number | null;
  output: number | null;
  cacheRead?: number | null;
  cacheWrite?: number | null;
}

function readPriceValue(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseFloat(value)
        : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function readPricePerMillion(value: unknown): number | null {
  const parsed = readPriceValue(value);
  return parsed == null ? null : parsed / 1_000_000;
}

function readUsdCentsPer100Million(value: unknown): number | null {
  const parsed = readPriceValue(value);
  return parsed == null ? null : parsed / 100 / 100_000_000;
}

export function readDiscoveredModelPricingUsdPerToken(
  entry: Record<string, unknown>,
): DiscoveredModelPricingUsdPerToken | null {
  const pricing = isRecord(entry.pricing) ? entry.pricing : {};
  const input =
    readUsdCentsPer100Million(entry.prompt_text_token_price) ??
    readPriceValue(pricing.prompt) ??
    readPriceValue(pricing.input) ??
    readPriceValue(pricing.input_usd_per_token) ??
    readPriceValue(pricing.inputUsdPerToken) ??
    readPriceValue(entry.input_usd_per_token) ??
    readPriceValue(entry.inputUsdPerToken) ??
    readPricePerMillion(pricing.input_per_million) ??
    readPricePerMillion(pricing.inputPerMillion) ??
    readPricePerMillion(pricing.input_usd_per_million) ??
    readPricePerMillion(pricing.inputUsdPerMillion) ??
    readPricePerMillion(entry.input_per_million) ??
    readPricePerMillion(entry.inputPerMillion) ??
    readPricePerMillion(entry.input_usd_per_million) ??
    readPricePerMillion(entry.inputUsdPerMillion);
  const output =
    readUsdCentsPer100Million(entry.completion_text_token_price) ??
    readPriceValue(pricing.completion) ??
    readPriceValue(pricing.output) ??
    readPriceValue(pricing.output_usd_per_token) ??
    readPriceValue(pricing.outputUsdPerToken) ??
    readPriceValue(entry.output_usd_per_token) ??
    readPriceValue(entry.outputUsdPerToken) ??
    readPricePerMillion(pricing.output_per_million) ??
    readPricePerMillion(pricing.outputPerMillion) ??
    readPricePerMillion(pricing.output_usd_per_million) ??
    readPricePerMillion(pricing.outputUsdPerMillion) ??
    readPricePerMillion(entry.output_per_million) ??
    readPricePerMillion(entry.outputPerMillion) ??
    readPricePerMillion(entry.output_usd_per_million) ??
    readPricePerMillion(entry.outputUsdPerMillion);
  if (input == null && output == null) return null;
  const cacheRead =
    readPriceValue(pricing.input_cache_read) ??
    readPriceValue(pricing.cache_read) ??
    readPriceValue(pricing.cacheRead) ??
    readPriceValue(pricing.cached_input) ??
    readPriceValue(pricing.cache_read_usd_per_token) ??
    readPricePerMillion(pricing.cache_read_per_million) ??
    readPricePerMillion(pricing.cacheReadPerMillion) ??
    readPricePerMillion(pricing.cache_read_usd_per_million);
  const cacheWrite =
    readPriceValue(pricing.input_cache_write) ??
    readPriceValue(pricing.cache_write) ??
    readPriceValue(pricing.cacheWrite) ??
    readPriceValue(pricing.cache_write_usd_per_token) ??
    readPricePerMillion(pricing.cache_write_per_million) ??
    readPricePerMillion(pricing.cacheWritePerMillion) ??
    readPricePerMillion(pricing.cache_write_usd_per_million);
  return {
    input,
    output,
    ...(cacheRead != null ? { cacheRead } : {}),
    ...(cacheWrite != null ? { cacheWrite } : {}),
  };
}
