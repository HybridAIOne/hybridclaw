/**
 * Retry safety of a whole agent run: a run that reported tool progress,
 * returned tool history/executions, recovered/refused evidence, queued effects,
 * or awaits approval is final, returned or thrown,
 * since a re-run repeats side effects (bash, writes, emails, `delegate`).
 * Callers pass their own tool progress: host-built crash outputs carry no
 * `toolExecutions`. NOT an error classifier like `classifyGatewayError`.
 */
export function isRetrySafeRun(
  output:
    | {
        recovery?: unknown;
        sideEffects?: unknown;
        toolHistory?: readonly unknown[];
        toolHistoryForReplay?: readonly unknown[];
        pendingApproval?: unknown;
        toolExecutions?: readonly unknown[];
      }
    | null
    | undefined,
  toolProgressReported: boolean,
): boolean {
  return (
    !toolProgressReported &&
    !output?.recovery &&
    !output?.pendingApproval &&
    !output?.sideEffects &&
    (output?.toolHistory?.length ?? 0) === 0 &&
    (output?.toolHistoryForReplay?.length ?? 0) === 0 &&
    (output?.toolExecutions?.length ?? 0) === 0
  );
}
