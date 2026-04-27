import { isRecord } from './utils.js';

export interface DiscoveredModelPricingUsdPerToken {
  input: number | null;
  output: number | null;
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

export function readDiscoveredModelPricingUsdPerToken(
  entry: Record<string, unknown>,
): DiscoveredModelPricingUsdPerToken | null {
  const pricing = isRecord(entry.pricing) ? entry.pricing : {};
  const input =
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
  return { input, output };
}
