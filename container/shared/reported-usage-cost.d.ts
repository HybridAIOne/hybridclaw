/** Only a finite, non-negative provider-reported amount is an observed charge. */
import type { RuntimeProviderId } from './provider-ids.js';

export function readReportedUsageCost(
  value: unknown,
  provider?: RuntimeProviderId,
): number | null;
