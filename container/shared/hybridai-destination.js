/**
 * Destination contract shared by gateway and worker transports.
 * A contracted offer binds every request to its advertised destination; this
 * verifies protocol agreement, not the infrastructure claims of the operator.
 */
export function parseHybridAIDestination(value, baseUrl) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid HybridAI destination contract');
  const {
    protocol,
    id,
    zone,
    operator,
    region,
    retention,
    fallback,
    apiBaseUrl,
  } = value;
  if (
    protocol !== 'hybridai-destination-v1' ||
    typeof id !== 'string' ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(id) ||
    !['hai', 'region', 'cloud'].includes(zone) ||
    fallback !== 'deny' ||
    [operator, region, retention].some(
      (field) =>
        typeof field !== 'string' || !field.trim() || field.length > 256,
    ) ||
    typeof apiBaseUrl !== 'string' ||
    apiBaseUrl.replace(/\/+$/, '') !== baseUrl.replace(/\/+$/, '') ||
    (zone === 'region' && region !== 'EU')
  ) {
    throw new Error('Incomplete or mismatched HybridAI destination contract');
  }
  return {
    protocol,
    id,
    zone,
    operator,
    region,
    retention,
    fallback,
    apiBaseUrl,
  };
}

export function hybridAIDestinationHeaders(destination) {
  return destination
    ? {
        'X-HybridAI-Destination-Protocol': destination.protocol,
        'X-HybridAI-Destination-ID': destination.id,
        'X-HybridAI-Destination-Zone': destination.zone,
        'X-HybridAI-Destination-Fallback': 'deny',
      }
    : {};
}

export async function fetchHybridAIDestination(url, init) {
  const headers = new Headers(init.headers);
  const expectedId = headers.get('X-HybridAI-Destination-ID');
  const response = await fetch(url, { ...init, redirect: 'error' });
  if (expectedId && response.ok) {
    for (const name of [
      'X-HybridAI-Destination-Protocol',
      'X-HybridAI-Destination-ID',
      'X-HybridAI-Destination-Zone',
      'X-HybridAI-Destination-Fallback',
    ]) {
      if (
        !headers.get(name) ||
        response.headers.get(name) !== headers.get(name)
      ) {
        await response.body?.cancel();
        throw new Error(
          'HybridAI did not acknowledge the requested destination; response rejected',
        );
      }
    }
  }
  return response;
}
