import { getRuntimeConfig } from '../config/runtime-config.js';
import { withSecretHeader } from '../security/secret-handles.js';
import {
  hardenSecretRef,
  resolveSecretHandleInput,
  type SecretRef,
} from '../security/secret-refs.js';
import { normalizeManagedCloudEndpointUrl } from './managed-cloud-provider.js';
import { noopSecretAudit } from './playwright-utils.js';

export interface ManagedBrowserPoolDoctorResult {
  ok: boolean;
  endpointUrl: string;
  nodeCount: number;
  healthyNodeCount: number;
  message: string;
}

type HealthResponse = {
  ok?: unknown;
  nodes?: unknown;
};

function countHealthyNodes(nodes: unknown): {
  nodeCount: number;
  healthyNodeCount: number;
} {
  if (!Array.isArray(nodes)) return { nodeCount: 0, healthyNodeCount: 0 };
  let healthyNodeCount = 0;
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const status = String((node as Record<string, unknown>).status || '');
    if (status === 'healthy' || status === 'idle' || status === 'leased') {
      healthyNodeCount += 1;
    }
  }
  return { nodeCount: nodes.length, healthyNodeCount };
}

function authHeaders(poolTokenRef?: SecretRef): Record<string, string> {
  if (!poolTokenRef) return {};
  const handle = resolveSecretHandleInput(hardenSecretRef(poolTokenRef), {
    path: 'browser.managedCloud.poolTokenRef',
    required: true,
    sinkKind: 'http',
  });
  if (!handle) {
    throw new Error('Managed browser pool token did not resolve.');
  }
  const header = withSecretHeader(handle, 'Authorization', {
    prefix: 'Bearer',
    audit: noopSecretAudit,
  });
  return { [header.name]: header.value };
}

export async function checkManagedBrowserPoolHealth(
  endpointUrl = getRuntimeConfig().browser.managedCloud.endpointUrl,
): Promise<ManagedBrowserPoolDoctorResult> {
  const config = getRuntimeConfig().browser.managedCloud;
  const normalizedEndpoint = normalizeManagedCloudEndpointUrl(endpointUrl);
  try {
    const response = await fetch(`${normalizedEndpoint}/health`, {
      method: 'GET',
      headers: authHeaders(config.poolTokenRef),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    let payload: HealthResponse = {};
    if (text.trim()) {
      payload = JSON.parse(text) as HealthResponse;
    }
    const { nodeCount, healthyNodeCount } = countHealthyNodes(payload.nodes);
    const ok = response.ok && payload.ok === true && healthyNodeCount > 0;
    return {
      ok,
      endpointUrl: normalizedEndpoint,
      nodeCount,
      healthyNodeCount,
      message: ok
        ? `Managed browser pool healthy: ${healthyNodeCount}/${nodeCount} nodes available.`
        : `Managed browser pool unhealthy at ${normalizedEndpoint}.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      endpointUrl: normalizedEndpoint,
      nodeCount: 0,
      healthyNodeCount: 0,
      message: `Managed browser pool health check failed at ${normalizedEndpoint}: ${message}`,
    };
  }
}
