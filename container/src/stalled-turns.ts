export const MAX_STALLED_MODEL_TURNS = 20;

export function advanceStalledTurnCount(params: {
  current: number;
  toolCalls: number;
  successfulToolCalls: number;
}): number {
  if (params.toolCalls > 0 && params.successfulToolCalls > 0) {
    return 0;
  }
  return params.current + 1;
}

export function shouldRetryEmptyFinalResponse(params: {
  visibleAssistantText: string | null | undefined;
  toolExecutionCount: number;
  artifactCount: number;
}): boolean {
  return (
    !params.visibleAssistantText?.trim() &&
    params.toolExecutionCount > 0 &&
    params.artifactCount === 0
  );
}
