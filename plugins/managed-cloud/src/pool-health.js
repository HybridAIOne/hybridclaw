import {
  normalizeManagedCloudEndpointUrl,
  poolAuthHeaders,
} from './provider.js';

const HEALTHY_NODE_STATUSES = new Set(['healthy', 'idle', 'leased']);

function countHealthyNodes(nodes) {
  if (!Array.isArray(nodes)) return { nodeCount: 0, healthyNodeCount: 0 };
  const healthyNodeCount = nodes.filter(
    (node) =>
      node &&
      typeof node === 'object' &&
      HEALTHY_NODE_STATUSES.has(String(node.status || '')),
  ).length;
  return { nodeCount: nodes.length, healthyNodeCount };
}

/** `GET /health` on the pool; healthy needs at least one usable node. */
export async function checkManagedBrowserPoolHealth({
  endpointUrl,
  poolToken,
  fetchImpl = fetch,
}) {
  const normalizedEndpoint = normalizeManagedCloudEndpointUrl(endpointUrl);
  try {
    const response = await fetchImpl(`${normalizedEndpoint}/health`, {
      method: 'GET',
      headers: poolAuthHeaders(poolToken),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    const payload = text.trim() ? JSON.parse(text) : {};
    const { nodeCount, healthyNodeCount } = countHealthyNodes(payload.nodes);
    const ok = response.ok && payload.ok === true && healthyNodeCount > 0;
    return {
      ok,
      endpointUrl: normalizedEndpoint,
      nodeCount,
      healthyNodeCount,
      message: ok
        ? `Managed browser pool healthy: ${healthyNodeCount}/${nodeCount} nodes available.`
        : `Managed browser pool unhealthy at ${normalizedEndpoint} (HTTP ${response.status}).`,
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
