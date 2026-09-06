/**
 * Tool ledger — the compact, persisted record of what an assistant turn
 * actually did with its tools, stored beside the assistant message.
 *
 * Built once when the turn is recorded, then rendered verbatim into later
 * prompts so a follow-up turn sees the real outcome of every call rather
 * than the model's own prose claim. Stored content is never rewritten: the
 * ledger lives in its own column and the trailer is appended only at prompt
 * time. Bounded so a tool-heavy turn cannot crowd out history.
 *
 * NOT the web-chat activity trace (`activity-trace.ts`), which keeps full
 * previews for the UI and never re-enters the prompt.
 */

import { redactCredentialSecrets } from '../security/redact.js';
import type { ToolExecution } from './execution.js';

export interface ToolLedgerEntry {
  tool: string;
  /** Identifying arguments, e.g. `send to:+49…` or `add cron:"0 7 * * *"`. */
  args?: string;
  ok: boolean;
  /** Short result excerpt (success) or failure reason (error). */
  note?: string;
}

// Caps (owner call, 2026-09-06): 24 entries / 2,000 chars keeps one turn's
// trailer under a tenth of the 24,000-char prompt history budget; richer
// per-call detail stays in the activity trace.
export const TOOL_LEDGER_MAX_ENTRIES = 24;
export const TOOL_LEDGER_MAX_CHARS = 2_000;
const ARGS_MAX_CHARS = 80;
const NOTE_MAX_CHARS = 160;
const ARG_VALUE_MAX_CHARS = 48;

const DIGEST_ARG_KEYS = [
  'action',
  'channel',
  'channelId',
  'to',
  'recipient',
  'taskId',
  'cron',
  'at',
  'every',
  'path',
  'filePath',
  'file',
  'url',
  'query',
  'name',
  'command',
] as const;

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function collapse(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

function formatArgValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? collapse(trimmed, ARG_VALUE_MAX_CHARS) : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

function buildArgsDigest(rawArguments: string): string | undefined {
  const args = parseJsonObject(rawArguments);
  if (!args) return undefined;
  const parts: string[] = [];
  for (const key of DIGEST_ARG_KEYS) {
    const formatted = formatArgValue(args[key]);
    if (!formatted) continue;
    parts.push(key === 'action' ? formatted : `${key}:${formatted}`);
    if (parts.length >= 4) break;
  }
  if (parts.length === 0) return undefined;
  return collapse(redactCredentialSecrets(parts.join(' ')), ARGS_MAX_CHARS);
}

function resolveOutcome(execution: ToolExecution): {
  ok: boolean;
  note?: string;
} {
  if (execution.blocked) {
    return {
      ok: false,
      note: collapse(
        redactCredentialSecrets(
          execution.blockedReason || 'blocked by security policy',
        ),
        NOTE_MAX_CHARS,
      ),
    };
  }
  const result = String(execution.result ?? '');
  const parsed = parseJsonObject(result);
  const structuredFailure =
    parsed != null && (parsed.ok === false || parsed.success === false);
  const failed =
    execution.isError === true ||
    structuredFailure ||
    /^\s*error:/i.test(result);
  let note = result;
  if (structuredFailure && typeof parsed.error === 'string') {
    note = parsed.error;
  } else if (failed) {
    note = result.replace(/^\s*error:\s*/i, '');
  }
  const collapsed = collapse(redactCredentialSecrets(note), NOTE_MAX_CHARS);
  return collapsed ? { ok: !failed, note: collapsed } : { ok: !failed };
}

export function buildToolLedger(
  toolExecutions: ToolExecution[] | null | undefined,
): ToolLedgerEntry[] {
  if (!Array.isArray(toolExecutions) || toolExecutions.length === 0) return [];
  const entries: ToolLedgerEntry[] = [];
  let totalChars = 0;
  for (const execution of toolExecutions) {
    if (entries.length >= TOOL_LEDGER_MAX_ENTRIES) break;
    const tool = String(execution.name || '').trim() || 'tool';
    const args = buildArgsDigest(execution.arguments);
    const outcome = resolveOutcome(execution);
    const entry: ToolLedgerEntry = {
      tool,
      ...(args ? { args } : {}),
      ok: outcome.ok,
      ...(outcome.note ? { note: outcome.note } : {}),
    };
    const entryChars = renderToolLedgerEntry(entry).length;
    if (totalChars + entryChars > TOOL_LEDGER_MAX_CHARS) break;
    totalChars += entryChars;
    entries.push(entry);
  }
  return entries;
}

export function serializeToolLedger(
  ledger: ToolLedgerEntry[] | null | undefined,
): string | null {
  return Array.isArray(ledger) && ledger.length > 0
    ? JSON.stringify(ledger)
    : null;
}

export function parseToolLedger(
  raw: string | null | undefined,
): ToolLedgerEntry[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const entries: ToolLedgerEntry[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const tool = typeof record.tool === 'string' ? record.tool.trim() : '';
      if (!tool) continue;
      entries.push({
        tool,
        ...(typeof record.args === 'string' && record.args
          ? { args: record.args }
          : {}),
        ok: record.ok === true,
        ...(typeof record.note === 'string' && record.note
          ? { note: record.note }
          : {}),
      });
    }
    return entries.length > 0 ? entries : undefined;
  } catch {
    return undefined;
  }
}

function renderToolLedgerEntry(entry: ToolLedgerEntry): string {
  const head = entry.args ? `${entry.tool} ${entry.args}` : entry.tool;
  const status = entry.ok ? 'ok' : 'error';
  return entry.note
    ? `${head} → ${status}: ${entry.note}`
    : `${head} → ${status}`;
}

/**
 * Renders the ledger as one bracketed trailer line. Deterministic for a given
 * stored ledger, so appending it never changes a cached history prefix.
 */
export function renderToolLedgerTrailer(
  ledger: ToolLedgerEntry[] | null | undefined,
): string {
  if (!Array.isArray(ledger) || ledger.length === 0) return '';
  const failed = ledger.filter((entry) => !entry.ok).length;
  const summary =
    failed > 0
      ? `${ledger.length} call(s), ${failed} failed`
      : `${ledger.length} call(s), all ok`;
  return `[tool ledger: ${summary}; ${ledger.map(renderToolLedgerEntry).join('; ')}]`;
}

export function appendToolLedgerTrailer(
  content: string,
  ledger: ToolLedgerEntry[] | null | undefined,
): string {
  const trailer = renderToolLedgerTrailer(ledger);
  if (!trailer) return content;
  const base = content.trimEnd();
  return base ? `${base}\n\n${trailer}` : trailer;
}
