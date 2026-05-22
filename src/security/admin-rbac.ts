export type AdminRbacAction =
  | 'secret.list_metadata'
  | 'secret.overwrite'
  | 'secret.unset';

function readClaimValue(
  payload: Record<string, unknown>,
  key: 'actions' | 'scope',
): unknown {
  return Object.hasOwn(payload, key) ? payload[key] : undefined;
}

export function collectAdminActionClaims(
  payload: Record<string, unknown> | null,
): Set<string> | null {
  if (!payload) return null;
  const claims = new Set<string>();

  const actions = readClaimValue(payload, 'actions');
  if (Array.isArray(actions)) {
    for (const entry of actions) {
      if (typeof entry === 'string' && entry.trim()) {
        claims.add(entry.trim());
      }
    }
  } else if (typeof actions === 'string') {
    for (const entry of actions.split(/[,\s]+/)) {
      if (entry.trim()) claims.add(entry.trim());
    }
  }

  const scope = readClaimValue(payload, 'scope');
  if (typeof scope === 'string') {
    for (const entry of scope.split(/\s+/)) {
      if (entry.trim()) claims.add(entry.trim());
    }
  }

  return claims;
}

export function isAdminActionAllowed(
  payload: Record<string, unknown> | null,
  action: AdminRbacAction,
): boolean {
  if (!payload) return true;
  const claims = collectAdminActionClaims(payload);
  return claims?.has(action) === true || claims?.has('secret:*') === true;
}
