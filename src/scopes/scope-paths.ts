/**
 * Where a scope's files live: `<agent workspace>/scopes/<scopeId>/`, a
 * workspace of its own. The agent workspace contains it, so the main chat
 * sees every scope; a scoped chat mounts only its own directory.
 *
 * A model can make links inside a workspace, so the gateway reads and writes
 * scope files only through these checks: no symlinked file or directory is
 * followed, and a scope directory must really be where its path says (fail
 * closed). NOT scope rows (`scope-store.ts`).
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  listScopeDirNamesIn,
  SCOPE_ID_RE,
  SCOPES_DIRNAME,
} from '../../container/shared/scope-dirs.js';
import { agentWorkspaceDir } from '../infra/ipc.js';

/** Prompt files a scope never loads: they belong to the agent's own setup. */
export const SCOPE_EXCLUDED_PROMPT_FILES: ReadonlySet<string> = new Set([
  'BOOTSTRAP.md',
  'OPENING.md',
  'BOOT.md',
  'HEARTBEAT.md',
  'PROACTIVE_PREFERENCES.md',
]);

export function scopeWorkspaceDir(agentId: string, scopeId: string): string {
  if (!SCOPE_ID_RE.test(scopeId)) {
    throw new Error(`Invalid scope id: ${scopeId}`);
  }
  return path.join(agentWorkspaceDir(agentId), SCOPES_DIRNAME, scopeId);
}

/** The workspace a session's files live in: its scope's, else its agent's. */
export function sessionWorkspaceDir(session: {
  agent_id: string;
  scope?: string | null;
}): string {
  return session.scope
    ? scopeWorkspaceDir(session.agent_id, session.scope)
    : agentWorkspaceDir(session.agent_id);
}

/**
 * Whether the scope's directory is a real directory at its own path; a
 * symlinked `scopes/` or scope directory would stand for another workspace.
 */
export function isRealScopeDir(agentId: string, scopeId: string): boolean {
  const agentDir = agentWorkspaceDir(agentId);
  const scopeDir = scopeWorkspaceDir(agentId, scopeId);
  try {
    for (const dir of [path.dirname(scopeDir), scopeDir]) {
      if (!fs.lstatSync(dir).isDirectory()) return false;
    }
    return (
      fs.realpathSync(scopeDir) ===
      path.join(fs.realpathSync(agentDir), SCOPES_DIRNAME, scopeId)
    );
  } catch {
    return false;
  }
}

/** Scope directory names under a workspace, for nightly consolidation. */
export function listScopeDirNames(workspaceDir: string): string[] {
  return listScopeDirNamesIn(path.join(workspaceDir, SCOPES_DIRNAME));
}

/**
 * Whether `relativePath` under `rootDir` is a regular file reached without
 * following a symlink at any step.
 */
export function isPlainFileUnder(
  rootDir: string,
  relativePath: string,
): boolean {
  const parts = relativePath.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === '..')) return false;
  let current = rootDir;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return false;
    }
    if (stat.isSymbolicLink()) return false;
    if (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) {
      return false;
    }
  }
  return true;
}
