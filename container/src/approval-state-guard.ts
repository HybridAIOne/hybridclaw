/**
 * Approval-state guard: a tool call that can change the files the approval
 * runtime trusts (policy, trust grants, pending approvals, session guard
 * state) is pinned red and waits for a human every time, full-auto included.
 *
 * Reads keep their tier, but bash cannot be split into reads and writes
 * statically, so any bash command naming these paths counts. Paths go through
 * the shared pinned-path matcher. NOT a sandbox: a path hidden in a variable,
 * interpreter code, or a symlink escapes the check.
 */
import type { ClassifiedAction } from './approval-policy.js';
import { matchesPathPattern } from './pinned-paths.js';
import { toWorkspaceRelativePath } from './runtime-paths.js';

// Security fix, 2026-09-26: the agent's own tools change these only with a
// human. Moving the files out of the agent's reach, which would also stop
// hidden-path shell writes, is deferred.
const APPROVAL_STATE_PATH_PATTERNS: readonly string[] = [
  '.hybridclaw/**',
  'approval-trust.json',
  '.hybridclaw-runtime/sessions/**',
];

// Tools whose call names the workspace path it changes.
const APPROVAL_STATE_WRITERS = new Set(['write', 'edit', 'delete', 'bash']);

// Relative, `/workspace/...`, and host-absolute paths name the same file, so
// the candidate is matched as a normalized workspace-relative path.
export function matchesApprovalStatePath(candidatePath: string): boolean {
  const relativePath = toWorkspaceRelativePath(candidatePath);
  return (
    relativePath !== null &&
    APPROVAL_STATE_PATH_PATTERNS.some((pattern) =>
      matchesPathPattern(relativePath, pattern),
    )
  );
}

export function changesApprovalState(
  toolName: string,
  pathHints: string[],
): boolean {
  return (
    APPROVAL_STATE_WRITERS.has(toolName.toLowerCase()) &&
    pathHints.some(matchesApprovalStatePath)
  );
}

// An agent that rewrites its own policy or trust files approves itself.
// Explicit approval keeps full-auto out; pinned_red keeps trust grants and
// promotion out.
export function guardApprovalStateChange(
  toolName: string,
  classified: ClassifiedAction,
): ClassifiedAction {
  if (!changesApprovalState(toolName, classified.pathHints)) return classified;
  return {
    ...classified,
    tier: 'red',
    actionKey: `approval-state:${toolName.toLowerCase()}`,
    consequenceIfDenied: 'the approval policy and trust files stay unchanged.',
    reason:
      'it names the approval policy or trust files, which change only with explicit human approval',
    promotableRed: false,
    stickyYellow: true,
    explicitApprovalRequired: true,
  };
}
