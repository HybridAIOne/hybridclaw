export declare function isRetrySafeRun(
  output:
    | {
        pendingApproval?: unknown;
        toolExecutions?: readonly unknown[];
      }
    | null
    | undefined,
  toolProgressReported: boolean,
): boolean;
