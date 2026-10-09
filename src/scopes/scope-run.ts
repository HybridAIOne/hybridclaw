/**
 * What a run in a scoped session uses: the scope's workspace (prompt files,
 * notes, transcripts, the worker's `/workspace` mount), its connector limits
 * and the scope's runtime token. Every runner of a session's turns (chat,
 * memory flush, isolated scheduled task, delegated subagent) asks here, and
 * a run whose scope was deleted does not start.
 *
 * NOT the session's binding to a scope (`scope-session.ts`).
 */
import type { ExecutorRequest } from '../agent/executor-types.js';
import type { Session } from '../types/session.js';
import {
  getConnectorDirectory,
  scopeBlockedTools,
} from './scope-connectors.js';
import { SCOPE_DELETED_ERROR, type ScopeRunError } from './scope-session.js';
import { getScope, type Scope } from './scope-store.js';
import { ensureScopeWorkspace } from './scope-workspace.js';

export interface ScopeRun {
  agentId: string;
  scope: Scope;
  /** Host path of the scope's workspace, mounted as `/workspace`. */
  workspaceDir: string;
  /** `blockedTools` entries for the scope's connector limits. */
  blockedTools: string[];
}

/**
 * The workspace and tool limits for a run in `session` (null when it has no
 * scope), or the error that stops the run.
 */
export async function resolveScopeRun(
  session: Pick<Session, 'scope'> | null | undefined,
  agentId: string,
  extraBlockedTools: readonly string[] = [],
): Promise<ScopeRun | ScopeRunError | null> {
  const scopeId = session?.scope;
  if (!scopeId) return null;
  const scope = getScope(agentId, scopeId);
  if (!scope) return SCOPE_DELETED_ERROR;
  const workspaceDir = ensureScopeWorkspace(agentId, scope.id);
  const directory = await getConnectorDirectory();
  return {
    agentId,
    scope,
    workspaceDir,
    blockedTools: [
      ...scopeBlockedTools(scope, directory),
      ...extraBlockedTools,
    ],
  };
}

/** What `runAgent` needs for a run in a scope: its mount and its token. */
export function scopeRunAgentParams(
  run: ScopeRun | null,
): Pick<ExecutorRequest, 'workspacePathOverride' | 'runtimeScope'> {
  if (!run) return {};
  return {
    workspacePathOverride: run.workspaceDir,
    runtimeScope: { agentId: run.agentId, scopeId: run.scope.id },
  };
}

export function isScopeRunError(
  value: ScopeRun | ScopeRunError | null,
): value is ScopeRunError {
  return Boolean(value && 'errorCode' in value);
}
