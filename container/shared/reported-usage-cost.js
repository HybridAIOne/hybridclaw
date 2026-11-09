/** Reported provider charges are metadata, never inferred from token counts. */
import { isRecord } from './primitive-values.js';

export function readReportedUsageCost(value, provider) {
  if (!isRecord(value)) return null;
  for (const candidate of [
    value.costUsd,
    value.costUSD,
    value.cost_usd,
    // OpenRouter credits are denominated in USD; other bare costs have no unit.
    provider === 'openrouter' ? value.cost : undefined,
  ]) {
    if (
      typeof candidate === 'number' &&
      Number.isFinite(candidate) &&
      candidate >= 0
    )
      return candidate;
  }
  return null;
}
