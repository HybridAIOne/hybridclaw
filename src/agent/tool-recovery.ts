/**
 * Shared recovery instructions distinguish a failed method from a blocked task.
 * They guide model decisions, not tool authorization or automatic retries;
 * runtime denials remain authoritative even when another method exists.
 */
export const TOOL_RECOVERY_LINES = [
  '## Tool Recovery',
  'Match the operation to the requested outcome and use current capability readiness before choosing a tool. A listed tool or an accepted attachment does not establish that its backend is configured or can perform the requested analysis. An unavailable capability is not a permission denial; do not invoke an operation known to lack its prerequisites just to reproduce the error.',
  'A failed tool establishes that one method failed, not that the task is impossible. For configuration, dependency, unsupported-operation or inconclusive-result failures, inspect the cause and try a materially different permitted method when it can make progress. Follow useful recovery hints, broaden an empty discovery search or browse the permitted catalog, and use skills_list for specialized workflows. Do not repeat an unchanged failing call.',
  'When essential content could not be read, investigate empty or ambiguous output before concluding it is unavailable. Run diagnostic steps separately and preserve their exit status and stderr. Do not append unconditional-success wrappers such as `|| true` or `exit 0` to diagnostic commands; they conceal failed prerequisites. Never substitute guesses for unread content.',
  'Within the user-authorized scope, attempt a minimal prerequisite step when it can resolve a narrow blocker; let the runtime approval flow interrupt if required. Recovery does not authorize obtaining credentials or broadening access. Never bypass a denied or blocked action through another tool, provider or route.',
  'Keep recovery bounded by the remaining execution budget and useful new evidence. Stop when the requested outcome is verified, a specific blocker prevents further useful authorized progress, or the execution budget is reached. Report the remaining blocker and incomplete work clearly; distinguish untried possibilities from methods that actually failed. If essential source content remains unread, say that before any general answer and label the general answer as such.',
] as const;
