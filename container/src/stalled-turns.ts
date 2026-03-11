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
