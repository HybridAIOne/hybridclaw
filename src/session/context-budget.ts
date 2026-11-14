/**
 * Session context budget — the one token budget that both prompt history
 * selection and session compaction measure against.
 *
 * Guarantees that compaction is triggered by the same number that would make
 * the next prompt drop turns, so stored history is either sent verbatim or
 * already folded into `session_summary`. The budget is the model's context
 * window scaled by `sessionCompaction.budgetRatio`; a non-zero
 * `sessionCompaction.tokenBudget` clips the window first.
 *
 * NOT the in-loop context guard (`sessionCompaction.inLoopGuard`), which
 * bounds tool results inside a single agent run.
 */
import {
  SESSION_COMPACTION_BUDGET_RATIO,
  SESSION_COMPACTION_TOKEN_BUDGET,
} from '../config/config.js';
import { getModelCatalogMetadata } from '../providers/model-catalog.js';

// 2k tokens (owner call, 2026-09-21): even when bootstrap files and daily
// notes consume the whole budget, the newest turns still get this much room.
export const MIN_HISTORY_BUDGET_TOKENS = 2_000;

// 100k: the cap every install carried until the cap became optional, kept as
// the window assumed for a model the catalog does not know.
const UNKNOWN_MODEL_CONTEXT_WINDOW_TOKENS = 100_000;

export function resolveSessionContextBudgetTokens(
  model: string | null | undefined,
): number {
  const cap = SESSION_COMPACTION_TOKEN_BUDGET || null;
  const normalizedModel = String(model || '').trim();
  const contextWindow = normalizedModel
    ? getModelCatalogMetadata(normalizedModel).contextWindow
    : null;
  const knownWindow =
    contextWindow != null && Number.isFinite(contextWindow) && contextWindow > 0
      ? contextWindow
      : null;
  const window = knownWindow ?? cap ?? UNKNOWN_MODEL_CONTEXT_WINDOW_TOKENS;
  const ratio = Math.max(0.05, Math.min(1, SESSION_COMPACTION_BUDGET_RATIO));
  return Math.max(1, Math.floor(Math.min(window, cap ?? window) * ratio));
}

export function resolveHistoryBudgetTokens(params: {
  model: string | null | undefined;
  promptOverheadTokens: number;
}): number {
  const total = resolveSessionContextBudgetTokens(params.model);
  const overhead = Number.isFinite(params.promptOverheadTokens)
    ? Math.max(0, Math.floor(params.promptOverheadTokens))
    : 0;
  return Math.max(MIN_HISTORY_BUDGET_TOKENS, total - overhead);
}
