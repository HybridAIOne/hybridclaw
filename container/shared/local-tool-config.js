/**
 * Starter selection controls schema visibility, never tool permission.
 * Instance and agent settings share validation; catalog dispatch still uses the
 * filtered request allowlist rather than treating this list as authorization.
 */
// Owner decision, 2026-09-10: up to nine configured starters plus one catalog.
// Automatic relevance selection and larger starter profiles are deferred.
export const DEFAULT_LOCAL_STARTER_TOOLS = [
  'read',
  'write',
  'edit',
  'bash',
  'glob',
  'grep',
  'skills_list',
  'web_search',
  'web_fetch',
];

export function normalizeLocalStarredNames(value, field) {
  if (value === undefined || value === null) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > 9 ||
    value.some((name) => typeof name !== 'string' || !name.trim())
  ) {
    throw new Error(
      `${field} must be an array of at most nine non-empty tool names.`,
    );
  }
  const names = value.map((name) => name.trim());
  if (new Set(names).size !== names.length) {
    throw new Error(`${field} must contain unique names.`);
  }
  return names;
}

// Owner decision, 2026-09-10: local requests default to starred schemas;
// Full remains an explicit per-instance or per-agent choice in Admin Tools.
export function normalizeLocalContextMode(value, field) {
  if (value === undefined || value === null) return undefined;
  if (value !== 'full' && value !== 'starred') {
    throw new Error(`${field} must be full or starred.`);
  }
  return value;
}

export function normalizeLocalStarterTools(value, field) {
  const names = normalizeLocalStarredNames(value, field);
  if (names?.includes('tool_catalog'))
    throw new Error(`${field} must not include tool_catalog.`);
  return names;
}
