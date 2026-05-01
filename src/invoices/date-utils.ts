import type { InvoiceListOptions } from './types.js';

export function sinceTimestamp(
  options: InvoiceListOptions,
  label = 'invoice since date',
): number | null {
  if (!options.since) return null;
  const timestamp = new Date(options.since).getTime();
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid ${label}: ${options.since}`);
  }
  return timestamp;
}
