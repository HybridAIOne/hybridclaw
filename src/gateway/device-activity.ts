/**
 * Pages a stored reply's execution record for its owning phone. The caller must
 * authorize the message first; this does not grant history or audit access.
 * Uses the existing persisted trace, never reconstructs success from prose.
 */
import { withMemoryDatabase } from '../memory/database.js';
import { queryOne } from '../memory/sqlite.js';
import { redactCredentialSecrets } from '../security/redact.js';
import { parseActivityTrace } from '../types/activity-trace.js';

// 2026-10-04: bounded phone pages; larger recorded previews are explicitly clipped.
const PAGE_SIZE = 20;
const TEXT_LIMIT = 8000;

export function readDeviceActivity(
  sessionId: string,
  messageId: number,
  offset: number,
) {
  const row = withMemoryDatabase((db) =>
    queryOne<{ activity_trace_json: string | null }>(
      db,
      "SELECT activity_trace_json FROM messages WHERE session_id = ? AND id = ? AND role = 'assistant'",
      sessionId,
      messageId,
    ),
  );
  const trace = parseActivityTrace(row?.activity_trace_json);
  const all = trace?.steps ?? [];
  const steps = all.slice(offset, offset + PAGE_SIZE).map((step, index) => {
    let truncated = false;
    const text = (value: string | undefined, limit = TEXT_LIMIT) => {
      if (value === undefined) return undefined;
      const safe = redactCredentialSecrets(value, true);
      if (safe.length > limit) truncated = true;
      return safe.slice(0, limit);
    };
    const value =
      step.kind === 'tool'
        ? {
            kind: step.kind,
            toolName: text(step.toolName, 200),
            // Existing traces record a returned tool, not whether it succeeded.
            status: 'recorded',
            argsPreview: text(step.argsPreview),
            resultPreview: text(step.resultPreview),
            durationMs:
              typeof step.durationMs === 'number' &&
              Number.isFinite(step.durationMs) &&
              step.durationMs >= 0
                ? step.durationMs
                : undefined,
          }
        : { kind: step.kind, text: text(step.text) };
    return { ...value, index: offset + index, truncated };
  });
  const end = offset + steps.length;
  return {
    version: 1,
    offset,
    total: all.length,
    steps,
    nextOffset: end < all.length ? end : null,
    elapsedMs:
      typeof trace?.elapsedMs === 'number' &&
      Number.isFinite(trace.elapsedMs) &&
      trace.elapsedMs >= 0
        ? trace?.elapsedMs
        : null,
  };
}
