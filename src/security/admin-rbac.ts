export type AdminRbacAction =
  | 'secret.list_metadata'
  | 'secret.overwrite'
  | 'secret.unset';

function readRecordProperty(
  record: Record<string, unknown>,
  keys: string[],
): unknown {
  for (const key of keys) {
    if (Object.hasOwn(record, key)) {
      return record[key];
    }
  }
  return undefined;
}

export function collectAdminActionClaims(
  payload: Record<string, unknown> | null,
): Set<string> | null {
  if (!payload) return null;
  const claims = new Set<string>();
  let sawClaimField = false;
  for (const key of ['actions', 'permissions', 'scopes', 'scope']) {
    const value = readRecordProperty(payload, [key]);
    if (Array.isArray(value)) {
      sawClaimField = true;
      for (const entry of value) {
        if (typeof entry === 'string' && entry.trim()) {
          claims.add(entry.trim());
        }
      }
      continue;
    }
    if (typeof value === 'string') {
      sawClaimField = true;
      for (const entry of value.split(/[,\s]+/)) {
        if (entry.trim()) claims.add(entry.trim());
      }
    }
  }
  return sawClaimField ? claims : null;
}

export function isAdminActionAllowed(
  payload: Record<string, unknown> | null,
  action: AdminRbacAction,
): boolean {
  const claims = collectAdminActionClaims(payload);
  if (claims === null) return true;
  return (
    claims.has(action) ||
    claims.has('secret:*') ||
    claims.has('admin:*') ||
    claims.has('*')
  );
}
