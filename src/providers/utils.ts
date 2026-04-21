export { isRecord, normalizeBaseUrl } from '../utils/shared-utils.js';

export function readPositiveInteger(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

export function createDiscoveryStore<T>(initialState: T, ttlMs = 3_600_000) {
  let state = initialState;
  let discoveredAtMs = 0;
  let discoveryInFlight: Promise<T> | null = null;

  const replaceState = (nextState: T, opts?: { skipCache?: boolean }) => {
    state = nextState;
    discoveredAtMs = opts?.skipCache ? 0 : Date.now();
  };

  const discover = async (
    fetchFreshState: () => Promise<T>,
    opts?: {
      force?: boolean;
      onError?: (err: unknown, staleState: T) => T | Promise<T>;
    },
  ): Promise<T> => {
    if (
      !opts?.force &&
      discoveredAtMs > 0 &&
      Date.now() - discoveredAtMs < ttlMs
    ) {
      return state;
    }
    if (discoveryInFlight) return discoveryInFlight;
    const staleState = state;
    discoveryInFlight = (async () => {
      try {
        const nextState = await fetchFreshState();
        replaceState(nextState);
        return state;
      } catch (err) {
        return opts?.onError ? await opts.onError(err, staleState) : staleState;
      } finally {
        discoveryInFlight = null;
      }
    })();
    return discoveryInFlight;
  };

  return { getState: () => state, replaceState, discover };
}
