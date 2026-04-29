import { getDiscoveredHybridAIModelNames } from '../providers/hybridai-discovery.js';
import {
  type HybridAIHealthResult,
  hybridAIProbe,
} from '../providers/hybridai-health.js';
import { localBackendsProbe } from '../providers/local-health.js';
import type {
  HealthCheckResult,
  LocalBackendType,
} from '../providers/local-types.js';
import { dedupeStrings } from '../utils/normalized-strings.js';
import type { GatewayProviderHealthEntry } from './gateway-types.js';

const GATEWAY_STATUS_PROVIDER_PROBE_TIMEOUT_MS = 750;

export interface GatewayHealthOptions {
  refreshProviderHealth?: boolean;
}

async function withProbeDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: () => T,
): Promise<T> {
  let timeout!: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<T>((resolve) => {
    timeout = setTimeout(() => resolve(fallback()), timeoutMs);
  });
  const probePromise = promise.catch(() => fallback());

  try {
    return await Promise.race([probePromise, timeoutPromise]);
  } finally {
    clearTimeout(timeout);
  }
}

function fallbackLocalBackendsHealth(): Map<
  LocalBackendType,
  HealthCheckResult
> {
  return localBackendsProbe.peek() ?? new Map();
}

function fallbackHybridAIHealth(): HybridAIHealthResult {
  const cached = hybridAIProbe.peek();
  if (cached) return cached;
  return {
    reachable: false,
    error: 'unavailable',
    latencyMs: 0,
  };
}

export function resolveGatewayLocalBackendsHealth(
  options: GatewayHealthOptions = {},
): Promise<Map<LocalBackendType, HealthCheckResult>> {
  if (options.refreshProviderHealth === false) {
    return Promise.resolve(fallbackLocalBackendsHealth());
  }
  return withProbeDeadline(
    localBackendsProbe.get(),
    GATEWAY_STATUS_PROVIDER_PROBE_TIMEOUT_MS,
    fallbackLocalBackendsHealth,
  );
}

export function resolveGatewayHybridAIHealth(
  options: GatewayHealthOptions = {},
): Promise<HybridAIHealthResult> {
  if (options.refreshProviderHealth === false) {
    return Promise.resolve(fallbackHybridAIHealth());
  }
  return withProbeDeadline(
    hybridAIProbe.get(),
    GATEWAY_STATUS_PROVIDER_PROBE_TIMEOUT_MS,
    fallbackHybridAIHealth,
  );
}

export function invalidateGatewayProviderHealth(): void {
  localBackendsProbe.invalidate();
  hybridAIProbe.invalidate();
}

export function buildGatewayHybridAIProviderEntry(
  probe: HybridAIHealthResult,
): GatewayProviderHealthEntry {
  const discoveredModelCount = dedupeStrings(
    getDiscoveredHybridAIModelNames(),
  ).length;

  return {
    kind: 'remote',
    reachable: probe.reachable,
    ...(probe.error ? { error: probe.error } : {}),
    latencyMs: probe.latencyMs,
    modelCount: probe.modelCount ?? discoveredModelCount,
    detail: probe.reachable
      ? `${probe.latencyMs}ms`
      : probe.error || 'unreachable',
  };
}
