/**
 * Verified users of running turns, scoped to their execution session.
 * Each cleanup removes only its own grant. Overlapping turns with different
 * users (or an anonymous turn) fail closed rather than sharing phone access.
 */
export interface TurnUser {
  userId: string;
  maxDeviceAgeMs?: number;
}
const users = new Map<string, Map<symbol, TurnUser | undefined>>();
export function currentTurnUser(sessionId: string): TurnUser | undefined {
  const grants = users.get(sessionId);
  if (!grants?.size) return undefined;
  let userId: string | undefined;
  let maxDeviceAgeMs: number | undefined;
  for (const grant of grants.values()) {
    if (!grant || (userId && userId !== grant.userId)) return undefined;
    userId = grant.userId;
    if (grant.maxDeviceAgeMs !== undefined) {
      maxDeviceAgeMs = Math.min(
        maxDeviceAgeMs ?? Infinity,
        grant.maxDeviceAgeMs,
      );
    }
  }
  return userId ? { userId, maxDeviceAgeMs } : undefined;
}
export function beginTurnUser(
  sessionId: string,
  userId: string | null | undefined,
  maxDeviceAgeMs?: number,
): () => void {
  const id = userId?.trim();
  const grant =
    id && id.length <= 200 ? { userId: id, maxDeviceAgeMs } : undefined;
  const key = Symbol();
  const grants = users.get(sessionId) ?? new Map();
  grants.set(key, grant);
  users.set(sessionId, grants);
  return () => {
    grants.delete(key);
    if (grants.size === 0 && users.get(sessionId) === grants)
      users.delete(sessionId);
  };
}
