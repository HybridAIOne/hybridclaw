/**
 * Bound default local reasoning and truncated-output recovery per turn.
 * Explicit reasoning choices bypass the cumulative default allowance.
 * Existing history remains authoritative; no actions or permissions are replayed.
 */
import type { ReasoningEffort } from '../shared/reasoning-effort.js';

// Runtime policy (Codex engineering decision, 2026-11-09): preserve an initial
// 8K generation allocation across calls, then finish default local turns without
// thinking where supported. Explicit effort and backend generation limits stay intact.
const DEFAULT_LOCAL_REASONING_TOKENS = 8_192;

export function localReasoningExhausted(params: {
  isLocal: boolean;
  reasoningEffort?: ReasoningEffort;
  finishReason: string | null | undefined;
  completionTokens: number;
}): boolean {
  return (
    params.isLocal &&
    (params.finishReason === 'length' ||
      (params.reasoningEffort === undefined &&
        params.completionTokens >= DEFAULT_LOCAL_REASONING_TOKENS))
  );
}

// One retry per turn (agent decision, 2026-11-08): recover one exhausted
// generation without letting successful tools reset an unbounded retry budget.
const MAX_LOCAL_OUTPUT_RECOVERIES = 1;

export function localOutputRecoveryPrompt(params: {
  isLocal: boolean;
  finishReason: string | null | undefined;
  toolCallCount: number;
  recoveryCount: number;
}): string | null {
  if (
    !params.isLocal ||
    params.finishReason !== 'length' ||
    params.toolCallCount !== 0 ||
    params.recoveryCount >= MAX_LOCAL_OUTPUT_RECOVERIES
  ) {
    return null;
  }
  return 'The previous generation exhausted its output-token budget and was not a completed answer. Continue from the recorded tool results with the same per-call budget. Keep reasoning brief and take the next necessary tool action, or give a concise verified answer if the work is complete. Do not repeat successful writes or sends; inspect stored state if an outcome is uncertain. Do not claim completion from unfinished output.';
}
