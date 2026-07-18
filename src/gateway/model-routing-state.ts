interface StickyRouteState {
  tier: string;
  remainingTurns: number;
}

const stickyRoutes = new Map<string, StickyRouteState>();
const MAX_STICKY_ROUTE_SESSIONS = 10_000;

export function peekStickyModelRoutingTier(
  sessionId: string,
): string | undefined {
  return stickyRoutes.get(sessionId.trim())?.tier;
}

export function consumeStickyModelRoutingTier(
  sessionId: string,
): string | undefined {
  const key = sessionId.trim();
  const state = stickyRoutes.get(key);
  if (!key || !state) return undefined;
  if (state.remainingTurns <= 1) {
    stickyRoutes.delete(key);
  } else {
    stickyRoutes.set(key, {
      ...state,
      remainingTurns: state.remainingTurns - 1,
    });
  }
  return state.tier;
}

export function setStickyModelRoutingTier(
  sessionId: string,
  tier: string,
  turns: number,
): void {
  const key = sessionId.trim();
  const normalizedTier = tier.trim();
  if (!key || !normalizedTier || turns <= 0) {
    stickyRoutes.delete(key);
    return;
  }
  if (
    !stickyRoutes.has(key) &&
    stickyRoutes.size >= MAX_STICKY_ROUTE_SESSIONS
  ) {
    const oldestKey = stickyRoutes.keys().next().value;
    if (oldestKey) stickyRoutes.delete(oldestKey);
  }
  stickyRoutes.set(key, {
    tier: normalizedTier,
    remainingTurns: Math.floor(turns),
  });
}

export function clearStickyModelRoutingTier(sessionId?: string): void {
  if (sessionId) {
    stickyRoutes.delete(sessionId.trim());
    return;
  }
  stickyRoutes.clear();
}
