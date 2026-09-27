/**
 * Retry safety of a whole agent run: a run that reported tool progress,
 * returned tool executions, or awaits approval is final, returned or thrown,
 * since a re-run repeats side effects (bash, writes, emails, `delegate`).
 * Callers pass their own tool progress: host-built crash outputs carry no
 * `toolExecutions`. NOT an error classifier like `classifyGatewayError`.
 */
export function isRetrySafeRun(output, toolProgressReported) {
  return (
    !toolProgressReported &&
    !output?.pendingApproval &&
    (output?.toolExecutions?.length ?? 0) === 0
  );
}
