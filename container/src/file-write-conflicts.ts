/**
 * Rejected file-write preconditions fence alternate mutation routes for a session.
 * Unlike write's byte comparison, this preserves the rejection across workers;
 * only a successful checked file mutation or a one-time approval can proceed.
 * Recovery diagnostics name the unresolved paths from that same store.
 * It stores paths, never file contents, and grants no filesystem permissions.
 */
import type { ClassifiedAction } from './approval-policy.js';
import {
  isWithinRoot,
  resolveCanonicalPath,
  resolveWorkspacePath,
} from './runtime-paths.js';
import { SessionStateSet } from './session-state.js';

const conflicts = new SessionStateSet('file-write-conflicts.json', true);

function targetKey(target: string): string {
  return resolveCanonicalPath(resolveWorkspacePath(target) ?? target);
}

export function recordFileWriteConflict(
  sessionId: string,
  target: string,
): void {
  if (!sessionId) return;
  conflicts.bindSession(sessionId);
  conflicts.add(targetKey(target));
}

export function resolveFileWriteConflict(
  sessionId: string,
  target: string,
): void {
  if (!sessionId) return;
  conflicts.bindSession(sessionId);
  conflicts.delete(targetKey(target));
}

export function guardFileWriteConflict(
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
  action: ClassifiedAction,
): ClassifiedAction {
  if (!sessionId) return action;
  conflicts.bindSession(sessionId);
  if (conflicts.size === 0) return action;
  const shellMutation =
    toolName === 'bash' && (action.tier !== 'green' || action.writeIntent);
  const conflictedDelete =
    toolName === 'delete' &&
    typeof args.path === 'string' &&
    [...conflicts].some((target) =>
      isWithinRoot(target, targetKey(args.path as string)),
    );
  if (!shellMutation && !conflictedDelete) return action;
  return {
    ...action,
    tier: 'red',
    pinned: true,
    actionKey: `file-write-conflict:${action.actionKey}`,
    promotableRed: false,
    explicitApprovalRequired: true,
    reason: `a file write was rejected because its replacement preconditions failed; alternate mutations require one-time approval. Unresolved paths: ${JSON.stringify([...conflicts])}. Read each path and use a checked write/edit to resolve it. Writing a separate file is permitted; executing scripts still requires approval until these conflicts are resolved`,
  };
}
