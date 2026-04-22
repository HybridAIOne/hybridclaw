import {
  SESSION_COMPACTION_KEEP_RECENT,
  SESSION_COMPACTION_THRESHOLD,
  SESSION_COMPACTION_TOKEN_BUDGET,
} from '../config/config.js';
import {
  readSessionStatusSnapshot,
  type SessionStatusSnapshot,
} from './gateway-session-status.js';

export interface ContextUsageSnapshot {
  sessionId: string;
  model: string;
  contextUsedTokens: number | null;
  contextBudgetTokens: number | null;
  contextUsagePercent: number | null;
  contextRemainingTokens: number | null;
  compactionCount: number;
  compactionTokenBudget: number;
  compactionMessageThreshold: number;
  compactionKeepRecent: number;
  messageCount: number;
  promptTokens: number | null;
  completionTokens: number | null;
}

export function buildContextUsageSnapshot(params: {
  sessionId: string;
  model: string;
  messageCount: number;
  compactionCount: number;
  modelContextWindowTokens: number | null;
  statusSnapshot?: SessionStatusSnapshot;
}): ContextUsageSnapshot {
  const snapshot =
    params.statusSnapshot ??
    readSessionStatusSnapshot(params.sessionId, {
      currentModel: params.model,
      modelContextWindowTokens: params.modelContextWindowTokens,
    });
  const contextRemaining =
    snapshot.contextUsedTokens != null && snapshot.contextBudgetTokens != null
      ? Math.max(0, snapshot.contextBudgetTokens - snapshot.contextUsedTokens)
      : null;
  return {
    sessionId: params.sessionId,
    model: params.model,
    contextUsedTokens: snapshot.contextUsedTokens,
    contextBudgetTokens: snapshot.contextBudgetTokens,
    contextUsagePercent: snapshot.contextUsagePercent,
    contextRemainingTokens: contextRemaining,
    compactionCount: Number.isFinite(params.compactionCount)
      ? Math.max(0, Math.trunc(params.compactionCount))
      : 0,
    compactionTokenBudget: Math.max(1_000, SESSION_COMPACTION_TOKEN_BUDGET),
    compactionMessageThreshold: Math.max(20, SESSION_COMPACTION_THRESHOLD),
    compactionKeepRecent: Math.max(1, SESSION_COMPACTION_KEEP_RECENT),
    messageCount: Number.isFinite(params.messageCount)
      ? Math.max(0, Math.trunc(params.messageCount))
      : 0,
    promptTokens: snapshot.promptTokens,
    completionTokens: snapshot.completionTokens,
  };
}
