export const MAX_STALLED_MODEL_TURNS = 20;
export const MAX_EMPTY_VISIBLE_COMPLETION_RETRIES = 1;
// 2 (agent call, 2026-09-27, pending owner review): enough for a model to
// resend a call cut off by the output-token limit in smaller pieces; a model
// that keeps emitting broken JSON fails the turn instead of looping.
export const MAX_INVALID_TOOL_CALL_RETRIES = 2;

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

export function shouldRetryEmptyVisibleCompletion(params: {
  retryCount: number;
  maxRetries?: number;
}): boolean {
  const maxRetries = Math.max(
    0,
    Math.floor(params.maxRetries ?? MAX_EMPTY_VISIBLE_COMPLETION_RETRIES),
  );
  return params.retryCount < maxRetries;
}
