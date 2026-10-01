import { logger } from '../logger.js';

export { isRecord } from '../utils/type-guards.js';

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/g, '');
}

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

export function formatUnknownError(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message.trim()
    : String(error);
}

interface DiscoveryStoreStateUpdate<T> {
  _tag: 'update';
  state: T;
  skipCache?: boolean;
}

type DiscoveryStoreOnErrorResult<T> = T | DiscoveryStoreStateUpdate<T>;

function isDiscoveryStoreStateUpdate<T>(
  value: DiscoveryStoreOnErrorResult<T>,
): value is DiscoveryStoreStateUpdate<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { _tag?: unknown })._tag === 'update'
  );
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
      onError?: (
        err: unknown,
        staleState: T,
      ) =>
        | DiscoveryStoreOnErrorResult<T>
        | Promise<DiscoveryStoreOnErrorResult<T>>;
    },
  ): Promise<T> => {
    const hasCache = discoveredAtMs > 0;
    if (!opts?.force && hasCache && Date.now() - discoveredAtMs < ttlMs) {
      return state;
    }
    // Stale-while-revalidate (turn-latency audit, 2026-10-01): an expired
    // cache answers now and refreshes in the background, so a chat turn never
    // waits on a catalog fetch. Only an empty store or a forced call waits.
    const waitForFresh = opts?.force === true || !hasCache;
    if (discoveryInFlight) return waitForFresh ? discoveryInFlight : state;
    const staleState = state;
    const refresh = (async () => {
      try {
        const nextState = await fetchFreshState();
        replaceState(nextState);
        return state;
      } catch (err) {
        if (!opts?.onError) return staleState;
        const fallback = await opts.onError(err, staleState);
        if (isDiscoveryStoreStateUpdate(fallback)) {
          replaceState(fallback.state, { skipCache: fallback.skipCache });
        } else {
          replaceState(fallback);
        }
        return state;
      } finally {
        discoveryInFlight = null;
      }
    })();
    discoveryInFlight = refresh;
    if (waitForFresh) return refresh;
    // onError reports fetch failures; this only catches a throwing onError,
    // which has no caller left to reach.
    refresh.catch((err) => {
      logger.warn({ err }, 'Background model discovery refresh failed');
    });
    return state;
  };

  return { getState: () => state, replaceState, discover };
}
