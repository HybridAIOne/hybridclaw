export declare function isRetrySafeRun(
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
): boolean;
