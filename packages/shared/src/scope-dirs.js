/**
 * Scope workspaces sit at `scopes/<scopeId>/` inside an agent workspace. The
 * gateway mounts only that directory for a scoped chat; the main chat's
 * workspace contains them all, so its memory and session searches read
 * them too. A name that is not a scope id is never a scope.
 */
import fs from 'node:fs';

export const SCOPES_DIRNAME = 'scopes';
export const SCOPE_ID_RE = /^s_[0-9a-f]{12}$/;

/** Scope directories (not links) directly in `scopesDir`, sorted. */
export function listScopeDirNamesIn(scopesDir) {
  try {
    return fs
      .readdirSync(scopesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SCOPE_ID_RE.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}
