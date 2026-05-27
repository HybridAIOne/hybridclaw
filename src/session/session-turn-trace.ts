import {
  parseJsonObject,
  readAuditBoolean as readBoolean,
  readAuditNumber as readNumber,
  readAuditString as readString,
  truncateAuditText,
} from '../audit/audit-trail.js';
import { logger } from '../logger.js';
import {
  redactHighEntropyStrings,
  redactSecretsDeep,
  URL_SECRET_QUERY_PARAM_RE,
} from '../security/redact.js';
import type { StructuredAuditEntry } from '../types/audit.js';

export interface AuditTurnTraceSelector {
  latest?: boolean;
  runId?: string;
  turnIndex?: number;
}

export interface AuditTurnGroup {
  runId: string;
  rows: StructuredAuditEntry[];
  turnStart: StructuredAuditEntry;
  position: number;
  turnIndex: number | null;
}

export interface AuditTurnSelectionResult {
  allTurns: AuditTurnGroup[];
  selectedTurns: AuditTurnGroup[];
  error: string | null;
}

export interface AuditTurnTraceToolRecord {
  order: number;
  toolCallId: string;
  toolName: string;
  kind: string;
  argumentsSummary: string;
  startedAt: string;
  durationMs: number | null;
  status: string;
  authorization: Array<{
    eventType: string;
    timestamp: string;
    summary: string;
  }>;
  resultSummary: string | null;
}

export interface AuditTurnTraceRecord {
  sessionId: string;
  runId: string;
  turn: number;
  timestamp: string;
  promptSummary: string;
  durationMs: number | null;
  summedToolDurationMs: number;
  modelUsage: string[];
  skills: string[];
  tools: AuditTurnTraceToolRecord[];
}

const TRACE_VALUE_PRESERVED_KEYS = new Set([
  'action',
  'allowed',
  'approvalBaseTier',
  'approvalDecision',
  'approvalTier',
  'autonomyLevel',
  'escalationRoute',
  'eventType',
  'model',
  'resource',
  'stakes',
  'status',
  'threshold',
  'toolCallId',
  'toolName',
  'traceJudge',
  'trajectoryCount',
  'tuple',
  'type',
]);

function redactTraceText(text: string, maxChars = 320): string {
  const redacted = redactHighEntropyStrings(
    String(redactSecretsDeep(text)).replace(
      URL_SECRET_QUERY_PARAM_RE,
      '$1***REDACTED***',
    ),
  );
  return truncateAuditText(redacted, maxChars);
}

function redactPreservedTraceText(text: string): string {
  return String(redactSecretsDeep(text)).replace(
    URL_SECRET_QUERY_PARAM_RE,
    '$1***REDACTED***',
  );
}

function redactTraceStructuredValue(value: unknown): unknown {
  const redacted = redactSecretsDeep(value);
  if (typeof redacted === 'string') return redactTraceText(redacted);
  if (Array.isArray(redacted)) {
    return redacted.map((entry) => redactTraceStructuredValue(entry));
  }
  if (!redacted || typeof redacted !== 'object') return redacted;

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(
    redacted as Record<string, unknown>,
  )) {
    if (TRACE_VALUE_PRESERVED_KEYS.has(key)) {
      out[key] = typeof raw === 'string' ? redactPreservedTraceText(raw) : raw;
      continue;
    }
    out[key] = redactTraceStructuredValue(raw);
  }
  return out;
}

function redactTraceValue(value: unknown, maxChars = 480): string {
  try {
    return truncateAuditText(
      JSON.stringify(redactTraceStructuredValue(value)),
      maxChars,
    );
  } catch {
    return redactTraceText(String(value), maxChars);
  }
}

function readTurnIndex(row: StructuredAuditEntry): number | null {
  return readNumber(parseJsonObject(row.payload), 'turnIndex');
}

export function groupAuditTurnRows(
  rows: StructuredAuditEntry[],
): AuditTurnGroup[] {
  const grouped = new Map<string, StructuredAuditEntry[]>();
  for (const row of [...rows].sort((left, right) => left.seq - right.seq)) {
    const bucket = grouped.get(row.run_id);
    if (bucket) {
      bucket.push(row);
      continue;
    }
    grouped.set(row.run_id, [row]);
  }

  const turns: AuditTurnGroup[] = [];
  for (const [runId, runRows] of grouped) {
    const turnStart = runRows.find((row) => row.event_type === 'turn.start');
    if (!turnStart) {
      logger.warn(
        { runId, rowCount: runRows.length },
        'audit turn group has no turn.start event, skipping',
      );
      continue;
    }
    turns.push({
      runId,
      rows: runRows,
      turnStart,
      position: 0,
      turnIndex: readTurnIndex(turnStart),
    });
  }

  return turns
    .sort((left, right) => left.turnStart.seq - right.turnStart.seq)
    .map((turn, index) => ({ ...turn, position: index + 1 }));
}

export function selectAuditTurnGroups(
  rows: StructuredAuditEntry[],
  selector?: AuditTurnTraceSelector | null,
): AuditTurnSelectionResult {
  const allTurns = groupAuditTurnRows(rows);
  if (
    !selector ||
    (!selector.latest && !selector.runId && selector.turnIndex == null)
  ) {
    return { allTurns, selectedTurns: allTurns, error: null };
  }

  if (selector.latest) {
    const latest = allTurns.at(-1);
    return {
      allTurns,
      selectedTurns: latest ? [latest] : [],
      error: latest ? null : 'No turn-level audit events are available.',
    };
  }

  if (selector.runId) {
    const selected = allTurns.filter((turn) => turn.runId === selector.runId);
    return {
      allTurns,
      selectedTurns: selected,
      error:
        selected.length > 0
          ? null
          : `No turn-level audit events matched run id \`${selector.runId}\`.`,
    };
  }

  if (selector.turnIndex != null) {
    const hasExplicitTurnIndex = allTurns.some(
      (turn) => turn.turnIndex != null,
    );
    const selected = allTurns.filter((turn) =>
      hasExplicitTurnIndex
        ? turn.turnIndex === selector.turnIndex
        : turn.position === selector.turnIndex,
    );
    return {
      allTurns,
      selectedTurns: selected,
      error:
        selected.length > 0
          ? null
          : `No turn-level audit events matched turn ${selector.turnIndex}.`,
    };
  }

  return { allTurns, selectedTurns: allTurns, error: null };
}

export function countCompletedTurnsBefore(
  allTurns: AuditTurnGroup[],
  selectedTurns: AuditTurnGroup[],
): number {
  const firstSelectedSeq = selectedTurns[0]?.turnStart.seq;
  if (firstSelectedSeq == null) return 0;
  let completed = 0;
  for (const turn of allTurns) {
    if (turn.turnStart.seq >= firstSelectedSeq) break;
    const turnEnd = turn.rows.find((row) => row.event_type === 'turn.end');
    const finishReason = turnEnd
      ? readString(parseJsonObject(turnEnd.payload), 'finishReason')
      : null;
    if (finishReason === 'completed') completed += 1;
  }
  return completed;
}

function durationBetween(start: string, end: string): number | null {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return Math.max(0, endMs - startMs);
}

function formatDuration(durationMs: number | null): string {
  if (durationMs == null) return 'unknown';
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function toolKind(toolName: string, payload: Record<string, unknown>): string {
  const explicit =
    readString(payload, 'toolKind') || readString(payload, 'callType');
  if (explicit) return explicit;
  if (
    readBoolean(payload, 'helper') === true ||
    readBoolean(payload, 'planning') === true
  ) {
    return 'helper/planning';
  }
  if (/^(plan|todo|thinking|update_plan|request_user_input)$/i.test(toolName)) {
    return 'helper/planning';
  }
  if (
    /^(web_fetch|web_search|http_request|browser_|managed_browser|firecrawl)/i.test(
      toolName,
    )
  ) {
    return 'network execution';
  }
  return 'execution';
}

function toolStatus(result: Record<string, unknown> | null): string {
  if (!result) return 'pending';
  if (readBoolean(result, 'blocked') === true) return 'blocked';
  if (readBoolean(result, 'isError') === true) return 'error';
  return 'ok';
}

function summarizeUsage(payload: Record<string, unknown>): string {
  const fields = [
    ['model', readString(payload, 'model')],
    ['provider', readString(payload, 'provider')],
    ['input', readNumber(payload, 'promptTokens')],
    ['output', readNumber(payload, 'completionTokens')],
    ['cache_read', readNumber(payload, 'cacheReadTokens')],
    ['cache_write', readNumber(payload, 'cacheWriteTokens')],
    ['total', readNumber(payload, 'totalTokens')],
    ['duration', readNumber(payload, 'durationMs')],
  ]
    .filter(([, value]) => value != null && value !== '')
    .map(([key, value]) =>
      key === 'duration'
        ? `${key}=${formatDuration(value as number)}`
        : `${key}=${value}`,
    );
  return fields.length > 0 ? fields.join(', ') : redactTraceValue(payload);
}

function summarizeSkill(payload: Record<string, unknown>): string {
  const skill =
    readString(payload, 'skillName') ||
    readString(payload, 'skill_id') ||
    'skill';
  const outcome =
    readString(payload, 'outcome') ||
    readString(payload, 'status') ||
    'observed';
  const duration =
    readNumber(payload, 'durationMs') ?? readNumber(payload, 'duration_ms');
  const failed = readNumber(payload, 'toolCallsFailed');
  return [
    `${skill}: ${outcome}`,
    duration != null ? formatDuration(duration) : null,
    failed != null ? `${failed} failed tool call(s)` : null,
  ]
    .filter(Boolean)
    .join(', ');
}

function auditAuthorizationRowsForTurn(rows: StructuredAuditEntry[]): {
  byToolCallId: Map<string, StructuredAuditEntry[]>;
  byAction: Map<string, StructuredAuditEntry[]>;
} {
  const byToolCallId = new Map<string, StructuredAuditEntry[]>();
  const byAction = new Map<string, StructuredAuditEntry[]>();
  const authEventTypes = new Set([
    'authorization.check',
    'autonomy.decision',
    'approval.request',
    'approval.response',
    'escalation.decision',
  ]);

  for (const row of rows) {
    if (!authEventTypes.has(row.event_type)) continue;
    const payload = parseJsonObject(row.payload);
    const toolCallId = readString(payload, 'toolCallId');
    if (toolCallId) {
      const entries = byToolCallId.get(toolCallId) || [];
      entries.push(row);
      byToolCallId.set(toolCallId, entries);
    }
    const action = readString(payload, 'action');
    if (action) {
      const entries = byAction.get(action) || [];
      entries.push(row);
      byAction.set(action, entries);
    }
  }

  return { byToolCallId, byAction };
}

export function buildAuditTurnTraceRecords(params: {
  sessionId: string;
  auditEntries: StructuredAuditEntry[];
  selector: AuditTurnTraceSelector;
}): { records: AuditTurnTraceRecord[] } | { error: string } {
  const selection = selectAuditTurnGroups(params.auditEntries, params.selector);
  if (selection.error) return { error: selection.error };
  if (selection.selectedTurns.length === 0) {
    return { error: 'No turn-level audit events are available.' };
  }

  const records: AuditTurnTraceRecord[] = [];
  for (const turn of selection.selectedTurns) {
    const turnStartPayload = parseJsonObject(turn.turnStart.payload);
    const turnEnd =
      turn.rows.find((row) => row.event_type === 'turn.end') || null;
    const turnEndPayload = turnEnd ? parseJsonObject(turnEnd.payload) : null;
    const lastRow = turn.rows.at(-1) || turn.turnStart;
    const totalDurationMs =
      readNumber(turnEndPayload || {}, 'durationMs') ??
      durationBetween(
        turn.turnStart.timestamp,
        turnEnd?.timestamp || lastRow.timestamp,
      );
    const toolResultRows = turn.rows.filter(
      (row) => row.event_type === 'tool.result',
    );
    const summedToolDurationMs = toolResultRows.reduce((sum, row) => {
      const duration = readNumber(parseJsonObject(row.payload), 'durationMs');
      return sum + (duration || 0);
    }, 0);
    const prompt =
      readString(turnStartPayload, 'userInput') ||
      readString(turnStartPayload, 'rawUserInput') ||
      readString(turnStartPayload, 'content') ||
      readString(turnStartPayload, 'text') ||
      '(prompt summary unavailable)';

    const resultByCallId = new Map<string, Record<string, unknown>>();
    for (const row of toolResultRows) {
      const payload = parseJsonObject(row.payload);
      const toolCallId = readString(payload, 'toolCallId');
      if (toolCallId) resultByCallId.set(toolCallId, payload);
    }
    const authorizationRows = auditAuthorizationRowsForTurn(turn.rows);

    const tools = turn.rows
      .filter((row) => row.event_type === 'tool.call')
      .map((row, index) => {
        const payload = parseJsonObject(row.payload);
        const toolCallId =
          readString(payload, 'toolCallId') ||
          `${turn.runId}:tool:${index + 1}`;
        const toolName = readString(payload, 'toolName') || 'unknown';
        const result = resultByCallId.get(toolCallId) || null;
        const resultSummary = result
          ? readString(result, 'resultPreview') ||
            readString(result, 'resultSummary') ||
            truncateAuditText(JSON.stringify(result), 280)
          : null;
        const authorizationRowsForTool = [
          ...(authorizationRows.byToolCallId.get(toolCallId) || []),
          ...(authorizationRows.byAction.get(`tool:${toolName}`) || []),
        ];
        const authorization = [...new Set(authorizationRowsForTool)].map(
          (entry) => ({
            eventType: entry.event_type,
            timestamp: entry.timestamp,
            summary: redactTraceValue(parseJsonObject(entry.payload), 520),
          }),
        );

        return {
          order: index + 1,
          toolCallId,
          toolName,
          kind: toolKind(toolName, payload),
          argumentsSummary: redactTraceValue(payload.arguments ?? {}, 700),
          startedAt: row.timestamp,
          durationMs: result ? readNumber(result, 'durationMs') : null,
          status: toolStatus(result),
          authorization,
          resultSummary: resultSummary
            ? redactTraceText(resultSummary, 520)
            : null,
        };
      });

    records.push({
      sessionId: params.sessionId,
      runId: turn.runId,
      turn: turn.turnIndex ?? turn.position,
      timestamp: turn.turnStart.timestamp,
      promptSummary: redactTraceText(prompt, 220),
      durationMs: totalDurationMs,
      summedToolDurationMs,
      modelUsage: turn.rows
        .filter((row) => row.event_type === 'model.usage')
        .map((row) => summarizeUsage(parseJsonObject(row.payload))),
      skills: turn.rows
        .filter((row) => row.event_type.startsWith('skill.'))
        .map((row) => summarizeSkill(parseJsonObject(row.payload))),
      tools,
    });
  }

  return { records };
}

export function formatAuditTurnTrace(params: {
  sessionId: string;
  auditEntries: StructuredAuditEntry[];
  selector: AuditTurnTraceSelector;
}): { title: string; text: string } | { error: string } {
  const built = buildAuditTurnTraceRecords(params);
  if ('error' in built) return built;
  const blocks = built.records.map((turn) => {
    const lines = [
      `Session: ${turn.sessionId}`,
      `Turn: ${turn.turn}`,
      `Run: ${turn.runId}`,
      `Timestamp: ${turn.timestamp}`,
      `Prompt: ${turn.promptSummary}`,
      `Duration: total ${formatDuration(turn.durationMs)}, tools ${formatDuration(turn.summedToolDurationMs)}`,
    ];

    if (turn.modelUsage.length > 0) {
      lines.push('Model usage:');
      lines.push(...turn.modelUsage.map((usage) => `- ${usage}`));
    }

    if (turn.skills.length > 0) {
      lines.push('Skills:');
      lines.push(...turn.skills.map((skill) => `- ${skill}`));
    }

    lines.push(turn.tools.length > 0 ? 'Tool calls:' : 'Tool calls: none');
    for (const tool of turn.tools) {
      lines.push(
        `${tool.order}. ${tool.toolName} (${tool.kind}) ${tool.status} started ${tool.startedAt} duration ${formatDuration(tool.durationMs)}`,
      );
      lines.push(`   args: ${tool.argumentsSummary}`);
      if (tool.authorization.length > 0) {
        lines.push('   authorization:');
        for (const auth of tool.authorization) {
          lines.push(`   - ${auth.eventType}: ${auth.summary}`);
        }
      }
      if (tool.resultSummary) {
        lines.push(`   result: ${tool.resultSummary}`);
      }
    }

    return lines.join('\n');
  });

  const title =
    built.records.length === 1
      ? `Audit Turn (${params.sessionId})`
      : `Audit Turns (${params.sessionId})`;
  return { title, text: blocks.join('\n\n') };
}
