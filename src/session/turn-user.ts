/**
 * The verified user of a running turn, scoped to its execution session.
 * Cleanup restores a nested binding; no user can be selected by a tool argument.
 * This is transient execution context, not durable session ownership.
 */
export interface TurnUser {
  userId: string;
  maxDeviceAgeMs?: number;
}
const users = new Map<string, TurnUser>();
export function currentTurnUser(sessionId: string): TurnUser | undefined {
  return users.get(sessionId);
}
export function beginTurnUser(
  sessionId: string,
  userId: string | null | undefined,
  maxDeviceAgeMs?: number,
): () => void {
  const id = userId?.trim();
  const previous = users.get(sessionId);
  const next =
    id && id.length <= 200 ? { userId: id, maxDeviceAgeMs } : undefined;
  if (next) users.set(sessionId, next);
  else users.delete(sessionId);
  return () => {
    if (users.get(sessionId) !== next) return;
    if (previous) users.set(sessionId, previous);
    else users.delete(sessionId);
  };
}
