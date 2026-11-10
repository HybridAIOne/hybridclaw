/**
 * Rejected file writes fence alternate mutations across a delegation family.
 * Unlike write's byte comparison, this preserves the rejection across workers;
 * only a successful checked file mutation or a one-time approval can proceed.
 * A fence lapses an hour after its last change. Trusted input selects the
 * root session and request; workers reload and lock its shared store.
 * It stores paths, never file contents, and grants no filesystem permissions.
 */
import fs from 'node:fs';
import type { FileWriteGuardContext } from '@hybridclaw/shared/file-write-guard';
import type { ClassifiedAction } from './approval-policy.js';
import {
  isWithinRoot,
  resolveCanonicalPath,
  resolveWorkspacePath,
} from './runtime-paths.js';
import { SessionStateSet, sessionStatePath } from './session-state.js';

const STATE_NAME = 'file-write-conflicts.json';
export const FILE_WRITE_CONFLICT_ACTION_PREFIX = 'file-write-conflict:';
const conflicts = new SessionStateSet(STATE_NAME, true);
const CONFLICT_LIFETIME_MS = 60 * 60 * 1000;
let activeSession = '';
let guardSession = '';
let guardUserPrompt: string | undefined;

export function setFileWriteGuardSession(
  sessionId: string,
  rootSessionId?: string,
  rootUserPrompt?: string,
): void {
  if (
    rootSessionId !== undefined &&
    (typeof rootSessionId !== 'string' || !rootSessionId.trim())
  ) {
    throw new Error('Invalid file-write guard session');
  }
  if (rootUserPrompt !== undefined && typeof rootUserPrompt !== 'string') {
    throw new Error('Invalid file-write guard request');
  }
  activeSession = sessionId;
  guardSession = rootSessionId ?? sessionId;
  guardUserPrompt = rootUserPrompt;
}

export function fileWriteReviewPrompt(
  sessionId: string,
  currentUserPrompt: string,
): string | undefined {
  return fileWriteReviewContext(sessionId, currentUserPrompt)
    .fileWriteGuardUserPrompt;
}

export function fileWriteReviewContext(
  sessionId: string,
  currentUserPrompt: string,
): FileWriteGuardContext {
  return {
    fileWriteGuardSessionId: stateSession(sessionId),
    fileWriteGuardUserPrompt:
      sessionId === activeSession && guardSession !== sessionId
        ? guardUserPrompt
        : currentUserPrompt,
  };
}

function stateSession(sessionId: string): string {
  return sessionId === activeSession ? guardSession : sessionId;
}

function lapsed(owner: string): boolean {
  const changed = fs.statSync(sessionStatePath(owner, STATE_NAME), {
    throwIfNoEntry: false,
  })?.mtimeMs;
  return changed !== undefined && Date.now() - changed > CONFLICT_LIFETIME_MS;
}

function targetKey(target: string): string {
  return resolveCanonicalPath(resolveWorkspacePath(target) ?? target);
}

function recoveryReason(): string {
  return `a file write was rejected because its replacement preconditions failed; alternate mutations require one-time approval. Unresolved paths: ${JSON.stringify([...conflicts])}. Read each path and use a checked write/edit to resolve it. Writing a separate file is permitted; executing scripts still requires approval until these conflicts are resolved`;
}

export async function recordFileWriteConflict(
  sessionId: string,
  target: string,
): Promise<string | undefined> {
  if (!sessionId) return undefined;
  const owner = stateSession(sessionId);
  await conflicts.updateLockedSession(owner, (values) => {
    if (lapsed(owner)) values.clear();
    values.add(targetKey(target));
  });
  return recoveryReason();
}

export async function resolveFileWriteConflict(
  sessionId: string,
  target: string,
): Promise<void> {
  if (!sessionId) return;
  await conflicts.updateLockedSession(stateSession(sessionId), (values) =>
    values.delete(targetKey(target)),
  );
}

function bindConflicts(sessionId: string): boolean {
  const owner = stateSession(sessionId);
  if (fs.existsSync(`${sessionStatePath(owner, STATE_NAME)}.lock`)) {
    throw new Error(
      'File-write guard state is locked; retry after its writer finishes',
    );
  }
  conflicts.bindSession(owner, true);
  return conflicts.size > 0 && !lapsed(owner);
}

export function getFileWriteConflict(
  sessionId: string,
  target: string,
): string | null {
  if (!sessionId || !bindConflicts(sessionId)) return null;
  const key = targetKey(target);
  return conflicts.has(key) ? key : null;
}

export function guardFileWriteConflict(
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
  action: ClassifiedAction,
): ClassifiedAction {
  if (!sessionId || !bindConflicts(sessionId)) return action;
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
    actionKey: `${FILE_WRITE_CONFLICT_ACTION_PREFIX}${action.actionKey}`,
    promotableRed: false,
    explicitApprovalRequired: true,
    reason: recoveryReason(),
  };
}
