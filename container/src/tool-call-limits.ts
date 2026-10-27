/**
 * Reserves tool calls before execution, independently of progress notifications.
 * Counters survive replacement workers for the same run in protected session state.
 * Unlike tool-count-limit, this limits executions, not exposed schemas.
 * It does not grant tool access or approval.
 */
import fs from 'node:fs';
import { writeFileAtomic } from '../shared/atomic-write.js';
import { isRecord } from '../shared/primitive-values.js';
import type { ToolCallLimits } from '../shared/tool-call-limits.js';
import { sessionStateKey, sessionStatePath } from './session-state.js';

let active: { path: string; limits: Map<string, number> } | null = null;

export function setToolCallLimits(
  input: ToolCallLimits & {
    sessionId: string;
    runId?: string;
  },
): void {
  active = null;
  if (input.toolCallLimits === undefined) return;
  if (!isRecord(input.toolCallLimits) || !input.sessionId || !input.runId) {
    throw new Error(
      'Tool call limits require a session, run ID and limit map.',
    );
  }
  const limits = new Map(Object.entries(input.toolCallLimits));
  for (const [name, limit] of limits) {
    if (!name.trim() || !Number.isSafeInteger(limit) || limit < 0) {
      throw new Error(
        'Tool call limits must be nonnegative integers for named tools.',
      );
    }
  }
  const filePath = sessionStatePath(
    input.sessionId,
    `tool-call-limits-${sessionStateKey(input.runId)}.json`,
  );
  try {
    fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    writeFileAtomic(filePath, '{}', { mode: 0o600, dirMode: 0o700 });
  }
  active = { path: filePath, limits };
}

export function reserveToolCall(name: string): void {
  const limit = active?.limits.get(name);
  if (!active || limit === undefined) return;
  const counts: unknown = JSON.parse(fs.readFileSync(active.path, 'utf-8'));
  if (
    !isRecord(counts) ||
    Object.values(counts).some(
      (count) =>
        typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0,
    )
  ) {
    throw new Error('Invalid persisted tool call counts; refusing execution.');
  }
  const used = Object.hasOwn(counts, name) ? (counts[name] as number) : 0;
  if (used >= limit)
    throw new Error(`Tool call limit reached for ${name} (${limit}).`);
  // Reserve synchronously before any await or side effect, including parallel calls.
  writeFileAtomic(
    active.path,
    JSON.stringify({ ...counts, [name]: used + 1 }),
    {
      mode: 0o600,
      dirMode: 0o700,
    },
  );
}
