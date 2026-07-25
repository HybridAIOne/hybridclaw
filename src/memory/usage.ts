import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AgentBudgetUnit } from '../agents/agent-types.js';
import { logger } from '../logger.js';
import { MODEL_METADATA_USD_TO_EUR } from '../providers/model-metadata.js';
import type { StructuredAuditEntry } from '../types/audit.js';
import type {
  UsageAgentAggregate,
  UsageAgentRollup,
  UsageDailyAggregate,
  UsageModelAggregate,
  UsageSessionAggregate,
  UsageTotals,
  UsageWindow,
} from '../types/usage.js';
import {
  normalizeNonNegativeInteger,
  normalizeNonNegativeNumber,
} from '../utils/number-normalization.js';
import {
  withInitializedMemoryDatabase,
  withMemoryDatabase,
} from './database.js';
import { resolveSessionIdCompat } from './sessions.js';
import { queryAll, queryOne } from './sqlite.js';

let usageEventBatchInsertStatement: Database.Statement | null = null;
let usageEventBatchDatabase: Database.Database | null = null;
const usageRecordSubscribers = new Set<UsageRecordSubscriber>();

function getUsageDatabase(): Database.Database {
  return withMemoryDatabase((database) => {
    if (usageEventBatchDatabase !== database) {
      usageEventBatchDatabase = database;
      usageEventBatchInsertStatement = null;
    }
    return database;
  });
}

function normalizeUsageWindow(window: UsageWindow | undefined): UsageWindow {
  if (window === 'daily' || window === 'monthly' || window === 'all') {
    return window;
  }
  return 'all';
}

function usageWindowWhereClause(window: UsageWindow): string | null {
  if (window === 'daily') {
    return "timestamp >= datetime('now', 'start of day')";
  }
  if (window === 'monthly') {
    return "timestamp >= datetime('now', 'start of month')";
  }
  return null;
}

export function normalizeUsageNumber(value: unknown): number {
  return normalizeNonNegativeInteger(value);
}

export function normalizeUsageCost(value: unknown): number {
  return normalizeNonNegativeNumber(value);
}

function applyUsageFilters(params: {
  whereClauses: string[];
  args: unknown[];
  agentId?: string;
  window?: UsageWindow;
}): void {
  const agentId = params.agentId?.trim();
  if (agentId) {
    params.whereClauses.push('agent_id = ?');
    params.args.push(agentId);
  }
  const window = normalizeUsageWindow(params.window);
  const windowClause = usageWindowWhereClause(window);
  if (windowClause) params.whereClauses.push(windowClause);
}

export interface RecordUsageEventEntry {
  sessionId: string;
  agentId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  toolCalls?: number;
  costUsd?: number;
  timestamp?: string;
  billableUnit?: string;
  billableQuantity?: number;
}

export interface RecordUsageEventBatchEntry extends RecordUsageEventEntry {
  id?: string;
  batchId?: string;
  batchHash?: string;
}

export type UsageRecordSubscriber = (agentIds: string[]) => unknown;

export interface BudgetSoftWarnMarkerEntry {
  agentId: string;
  billingWindow: string;
  emittedAt: string;
  used: number;
  cap: number;
  unit: AgentBudgetUnit;
  currency: 'USD' | 'EUR';
  percent: number;
}

export interface MonthlyUsageByAgentEntry {
  totalCostUsd: number;
  totalTokens: number;
}
export type MonthlyUsageByAgent = Map<string, MonthlyUsageByAgentEntry>;

type NormalizedUsageEventRow = {
  id: string;
  sessionId: string;
  agentId: string;
  timestamp: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  toolCalls: number;
  billableUnit: string | null;
  billableQuantity: number;
  batchId: string | null;
  batchHash: string | null;
};

function normalizeBillableUnit(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (!/^[a-z][a-z0-9._-]{0,62}$/u.test(normalized)) return null;
  return normalized;
}

function normalizeUsageEntry(
  entry: RecordUsageEventBatchEntry,
): NormalizedUsageEventRow | null {
  const sessionId = resolveSessionIdCompat(entry.sessionId.trim());
  const agentId = entry.agentId.trim();
  if (!sessionId || !agentId) return null;
  const inputTokens = normalizeUsageNumber(entry.inputTokens);
  const outputTokens = normalizeUsageNumber(entry.outputTokens);
  const totalTokens = normalizeUsageNumber(
    entry.totalTokens ?? inputTokens + outputTokens,
  );
  return {
    id:
      typeof entry.id === 'string' && entry.id.trim()
        ? entry.id.trim()
        : randomUUID(),
    sessionId,
    agentId,
    timestamp:
      typeof entry.timestamp === 'string' && entry.timestamp.trim()
        ? entry.timestamp.trim()
        : new Date().toISOString(),
    model: entry.model.trim() || 'unknown',
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd: normalizeUsageCost(entry.costUsd),
    toolCalls: normalizeUsageNumber(entry.toolCalls),
    billableUnit: normalizeBillableUnit(entry.billableUnit),
    billableQuantity: normalizeUsageCost(entry.billableQuantity),
    batchId:
      typeof entry.batchId === 'string' && entry.batchId.trim()
        ? entry.batchId.trim()
        : null,
    batchHash:
      typeof entry.batchHash === 'string' && entry.batchHash.trim()
        ? entry.batchHash.trim()
        : null,
  };
}

export function subscribeUsageRecords(
  subscriber: UsageRecordSubscriber,
): () => void {
  usageRecordSubscribers.add(subscriber);
  return () => {
    usageRecordSubscribers.delete(subscriber);
  };
}

function notifyUsageRecords(agentIds: Iterable<string>): void {
  if (usageRecordSubscribers.size === 0) return;
  const normalizedAgentIds = Array.from(
    new Set(
      Array.from(agentIds)
        .map((agentId) => agentId.trim())
        .filter(Boolean),
    ),
  );
  if (normalizedAgentIds.length === 0) return;

  queueMicrotask(() => {
    notifyUsageRecordSubscribers(normalizedAgentIds);
  });
}

function notifyUsageRecordSubscribers(agentIds: string[]): void {
  let subscriberIndex = 0;
  for (const subscriber of usageRecordSubscribers) {
    subscriberIndex += 1;
    try {
      subscriber(agentIds);
    } catch (error) {
      logger.warn(
        {
          subscriberIndex,
          error: error instanceof Error ? error.message : String(error),
        },
        'Usage record subscriber failed',
      );
    }
  }
}

export function hasBudgetSoftWarnMarker(
  agentId: string,
  billingWindow: string,
  unit: AgentBudgetUnit,
): boolean {
  const normalizedAgentId = agentId.trim();
  const normalizedBillingWindow = billingWindow.trim();
  if (!normalizedAgentId || !normalizedBillingWindow) return false;
  const row = queryOne<{ agent_id: string }, [string, string, AgentBudgetUnit]>(
    getUsageDatabase(),
    `SELECT agent_id
     FROM budget_soft_warn_events
     WHERE agent_id = ?
       AND billing_window = ?
       AND unit = ?
     LIMIT 1`,
    normalizedAgentId,
    normalizedBillingWindow,
    unit,
  );
  return Boolean(row);
}

export function recordBudgetSoftWarnMarker(
  entry: BudgetSoftWarnMarkerEntry,
): boolean {
  const agentId = entry.agentId.trim();
  const billingWindow = entry.billingWindow.trim();
  if (!agentId || !billingWindow) return false;
  const used =
    entry.unit === 'tokens'
      ? normalizeUsageNumber(entry.used)
      : normalizeUsageCost(entry.used);
  const cap =
    entry.unit === 'tokens'
      ? normalizeUsageNumber(entry.cap)
      : normalizeUsageCost(entry.cap);
  const result = getUsageDatabase()
    .prepare(
      `INSERT OR IGNORE INTO budget_soft_warn_events
        (agent_id, billing_window, emitted_at, used, cap, unit, currency, percent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      agentId,
      billingWindow,
      entry.emittedAt,
      used,
      cap,
      entry.unit,
      entry.currency,
      normalizeUsageCost(entry.percent),
    );
  return result.changes > 0;
}

function getUsageEventBatchInsertStatement(): Database.Statement {
  if (!usageEventBatchInsertStatement) {
    usageEventBatchInsertStatement = getUsageDatabase().prepare(
      `INSERT INTO usage_events
        (id, session_id, agent_id, timestamp, model, input_tokens, output_tokens, total_tokens, cost_usd, tool_calls, billable_unit, billable_quantity, batch_id, batch_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }
  return usageEventBatchInsertStatement;
}

export function recordUsageEvent(params: RecordUsageEventEntry): void {
  const row = normalizeUsageEntry(params);
  if (!row) return;

  getUsageDatabase()
    .prepare(
      `INSERT INTO usage_events
      (id, session_id, agent_id, timestamp, model, input_tokens, output_tokens, total_tokens, cost_usd, tool_calls, billable_unit, billable_quantity)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.sessionId,
      row.agentId,
      row.timestamp,
      row.model,
      row.inputTokens,
      row.outputTokens,
      row.totalTokens,
      row.costUsd,
      row.toolCalls,
      row.billableUnit,
      row.billableQuantity,
    );
  notifyUsageRecords([row.agentId]);
}

export interface UsageBatchHashRecord {
  sessionId: string;
  agentId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  toolCalls: number;
  costUsd: number;
  timestamp: string;
  batchId: string;
  batchHash: string | null;
}

/**
 * Bulk-insert usage events inside a single SQLite transaction.
 *
 * Used by the asynchronous token-usage buffer to amortize the write cost
 * of high-frequency model invocations. Each row is normalized identically
 * to {@link recordUsageEvent}; rows with missing session/agent ids are
 * silently dropped to preserve drop-on-the-floor semantics.
 */
export function recordUsageEventBatch(
  entries: RecordUsageEventBatchEntry[],
): void {
  if (!Array.isArray(entries) || entries.length === 0) return;

  const normalized: NormalizedUsageEventRow[] = [];
  for (const entry of entries) {
    const row = normalizeUsageEntry(entry);
    if (row) normalized.push(row);
  }
  if (normalized.length === 0) return;

  const database = withInitializedMemoryDatabase((initialized) => initialized);
  const insert = getUsageEventBatchInsertStatement();
  const transaction = database.transaction(
    (rows: NormalizedUsageEventRow[]) => {
      for (const row of rows) {
        insert.run(
          row.id,
          row.sessionId,
          row.agentId,
          row.timestamp,
          row.model,
          row.inputTokens,
          row.outputTokens,
          row.totalTokens,
          row.costUsd,
          row.toolCalls,
          row.billableUnit,
          row.billableQuantity,
          row.batchId,
          row.batchHash,
        );
      }
    },
  );
  transaction(normalized);
  notifyUsageRecords(normalized.map((row) => row.agentId));
}

export function listUsageEventsByBatchId(
  batchId: string,
): UsageBatchHashRecord[] {
  const normalizedBatchId = batchId.trim();
  if (!normalizedBatchId) return [];
  const rows = getUsageDatabase()
    .prepare(
      `SELECT
         session_id AS sessionId,
         agent_id AS agentId,
         model,
         input_tokens AS inputTokens,
         output_tokens AS outputTokens,
         total_tokens AS totalTokens,
         tool_calls AS toolCalls,
         cost_usd AS costUsd,
         timestamp,
         batch_id AS batchId,
         batch_hash AS batchHash
       FROM usage_events
       WHERE batch_id = ?
       ORDER BY id ASC`,
    )
    .all(normalizedBatchId) as UsageBatchHashRecord[];
  return rows;
}

function serializeRequestLogJson(value: unknown): string | null {
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

export function recordRequestLog(params: {
  sessionId: string;
  model?: string | null;
  chatbotId?: string | null;
  messages?: unknown;
  status?: string | null;
  response?: string | null;
  error?: string | null;
  toolExecutions?: unknown;
  toolsUsed?: unknown;
  durationMs?: number | null;
}): void {
  const sessionId = resolveSessionIdCompat(params.sessionId.trim());
  if (!sessionId) return;
  const model = params.model?.trim() || null;
  const chatbotId = params.chatbotId?.trim() || null;
  const status = params.status?.trim() || null;
  const response = params.response ?? null;
  const error = params.error ?? null;
  const durationMs =
    typeof params.durationMs === 'number' && Number.isFinite(params.durationMs)
      ? Math.max(0, Math.trunc(params.durationMs))
      : null;
  const createdAt = new Date().toISOString();

  getUsageDatabase()
    .prepare(
      `INSERT INTO request_log (
       session_id,
       model,
       chatbot_id,
       messages_json,
       status,
       response,
       error,
       tool_executions_json,
       tools_used,
       duration_ms,
       created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sessionId,
      model,
      chatbotId,
      serializeRequestLogJson(params.messages),
      status,
      response,
      error,
      serializeRequestLogJson(params.toolExecutions),
      serializeRequestLogJson(params.toolsUsed),
      durationMs,
      createdAt,
    );
}

export function getUsageTotals(params?: {
  agentId?: string;
  window?: UsageWindow;
}): UsageTotals {
  const whereClauses: string[] = [];
  const args: unknown[] = [];
  applyUsageFilters({
    whereClauses,
    args,
    agentId: params?.agentId,
    window: params?.window,
  });
  const where =
    whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const row = queryOne<UsageTotals>(
    getUsageDatabase(),
    `SELECT
         COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
         COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
         COALESCE(SUM(total_tokens), 0) AS total_tokens,
         COALESCE(SUM(cost_usd), 0.0) AS total_cost_usd,
         COALESCE(SUM(cost_usd) / NULLIF(COUNT(*), 0), 0.0) AS cost_per_call_usd,
         COUNT(*) AS call_count,
         COALESCE(SUM(tool_calls), 0) AS total_tool_calls
       FROM usage_events
       ${where}`,
    ...args,
  ) || {
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_tokens: 0,
    total_cost_usd: 0,
    cost_per_call_usd: 0,
    call_count: 0,
    total_tool_calls: 0,
  };

  const callCount = normalizeUsageNumber(row.call_count);
  const totalCostUsd = normalizeUsageCost(row.total_cost_usd);
  const billableUnits = getUsageBillableUnitTotals({
    agentId: params?.agentId,
    window: params?.window,
  });
  return {
    total_input_tokens: normalizeUsageNumber(row.total_input_tokens),
    total_output_tokens: normalizeUsageNumber(row.total_output_tokens),
    total_tokens: normalizeUsageNumber(row.total_tokens),
    total_cost_usd: totalCostUsd,
    cost_per_call_usd: normalizeUsageCost(row.cost_per_call_usd),
    call_count: callCount,
    total_tool_calls: normalizeUsageNumber(row.total_tool_calls),
    ...(billableUnits.length > 0 ? { billable_units: billableUnits } : {}),
  };
}

export function getUsageBillableUnitTotals(params?: {
  agentId?: string;
  window?: UsageWindow;
}): Array<{ unit: string; quantity: number; cost_usd: number }> {
  const whereClauses = [
    'billable_unit IS NOT NULL',
    "billable_unit <> ''",
    'billable_quantity > 0',
  ];
  const args: unknown[] = [];
  applyUsageFilters({
    whereClauses,
    args,
    agentId: params?.agentId,
    window: params?.window,
  });
  return queryAll<
    { unit: string; quantity: number | null; cost_usd: number | null },
    unknown[]
  >(
    getUsageDatabase(),
    `SELECT
       billable_unit AS unit,
       COALESCE(SUM(billable_quantity), 0.0) AS quantity,
       COALESCE(SUM(cost_usd), 0.0) AS cost_usd
     FROM usage_events
     WHERE ${whereClauses.join(' AND ')}
     GROUP BY billable_unit
     ORDER BY billable_unit ASC`,
    ...args,
  ).map((row) => ({
    unit: row.unit,
    quantity: normalizeUsageCost(row.quantity),
    cost_usd: normalizeUsageCost(row.cost_usd),
  }));
}

export function monthlySpendUsd(agentId: string): number {
  agentId = agentId.trim();
  if (!agentId) {
    throw new Error('Agent id is required.');
  }
  return getUsageTotals({ agentId, window: 'monthly' }).total_cost_usd;
}

export function monthlySpendEur(agentId: string): number {
  return monthlySpendUsd(agentId) / MODEL_METADATA_USD_TO_EUR.usdPerEur;
}

export function monthlyUsageByAgent(
  agentIds: string[],
  now = new Date(),
): MonthlyUsageByAgent {
  const normalizedAgentIds = Array.from(
    new Set(agentIds.map((agentId) => agentId.trim()).filter(Boolean)),
  );
  const usageByAgent = new Map<string, MonthlyUsageByAgentEntry>();
  if (normalizedAgentIds.length === 0) return usageByAgent;

  const placeholders = normalizedAgentIds.map(() => '?').join(', ');
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  ).toISOString();
  const rows = queryAll<
    {
      agent_id: string;
      total_cost_usd: number | null;
      total_tokens: number | null;
    },
    unknown[]
  >(
    getUsageDatabase(),
    `SELECT agent_id,
            COALESCE(SUM(cost_usd), 0.0) AS total_cost_usd,
            COALESCE(SUM(total_tokens), 0) AS total_tokens
     FROM usage_events
     WHERE timestamp >= ?
       AND agent_id IN (${placeholders})
     GROUP BY agent_id`,
    monthStart,
    ...normalizedAgentIds,
  );
  for (const row of rows) {
    usageByAgent.set(row.agent_id, {
      totalCostUsd: normalizeUsageCost(row.total_cost_usd),
      totalTokens: normalizeUsageNumber(row.total_tokens),
    });
  }
  return usageByAgent;
}

export function getSessionUsageTotals(sessionId: string): UsageTotals {
  return getSessionUsageTotalsSince(sessionId, null);
}

export interface RecentSessionUsageEvent {
  sessionId: string;
  agentId: string;
  model: string;
  totalTokens: number;
  timestamp: string;
}

export function getRecentSessionUsageEvents(
  sessionId: string,
  limit = 20,
): RecentSessionUsageEvent[] {
  const resolvedSessionId = resolveSessionIdCompat(sessionId);
  const boundedLimit =
    typeof limit === 'number' && Number.isFinite(limit)
      ? Math.max(1, Math.floor(limit))
      : 20;
  const rows = queryAll<
    {
      session_id: string;
      agent_id: string;
      model: string;
      total_tokens: number;
      timestamp: string;
    },
    [string, number]
  >(
    getUsageDatabase(),
    `SELECT session_id, agent_id, model, total_tokens, timestamp
     FROM usage_events
     WHERE session_id = ?
     ORDER BY timestamp DESC
     LIMIT ?`,
    resolvedSessionId,
    boundedLimit,
  );

  return rows.map((row) => ({
    sessionId: String(row.session_id || '').trim(),
    agentId: String(row.agent_id || '').trim(),
    model: String(row.model || '').trim(),
    totalTokens: normalizeUsageNumber(row.total_tokens),
    timestamp: String(row.timestamp || '').trim(),
  }));
}

export function getSessionUsageTotalsSince(
  sessionId: string,
  sinceTimestamp: string | null,
): UsageTotals {
  const resolvedSessionId = resolveSessionIdCompat(sessionId);
  const normalizedSince =
    typeof sinceTimestamp === 'string' && sinceTimestamp.trim()
      ? sinceTimestamp.trim()
      : null;
  const row = queryOne<UsageTotals, [string, string | null, string | null]>(
    getUsageDatabase(),
    `SELECT
         COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
         COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
         COALESCE(SUM(total_tokens), 0) AS total_tokens,
         COALESCE(SUM(cost_usd), 0.0) AS total_cost_usd,
         COALESCE(SUM(cost_usd) / NULLIF(COUNT(*), 0), 0.0) AS cost_per_call_usd,
         COUNT(*) AS call_count,
         COALESCE(SUM(tool_calls), 0) AS total_tool_calls
       FROM usage_events
       WHERE session_id = ?
         AND (? IS NULL OR timestamp >= ?)`,
    resolvedSessionId,
    normalizedSince,
    normalizedSince,
  ) || {
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_tokens: 0,
    total_cost_usd: 0,
    cost_per_call_usd: 0,
    call_count: 0,
    total_tool_calls: 0,
  };

  const callCount = normalizeUsageNumber(row.call_count);
  const totalCostUsd = normalizeUsageCost(row.total_cost_usd);
  return {
    total_input_tokens: normalizeUsageNumber(row.total_input_tokens),
    total_output_tokens: normalizeUsageNumber(row.total_output_tokens),
    total_tokens: normalizeUsageNumber(row.total_tokens),
    total_cost_usd: totalCostUsd,
    cost_per_call_usd: normalizeUsageCost(row.cost_per_call_usd),
    call_count: callCount,
    total_tool_calls: normalizeUsageNumber(row.total_tool_calls),
  };
}

export function getSessionToolCallBreakdown(
  sessionId: string,
  sinceTimestamp: string | null = null,
): Array<{ toolName: string; count: number }> {
  const resolvedSessionId = resolveSessionIdCompat(sessionId);
  const normalizedSince =
    typeof sinceTimestamp === 'string' && sinceTimestamp.trim()
      ? sinceTimestamp.trim()
      : null;
  const rows = queryAll<
    { payload: string },
    [string, string | null, string | null]
  >(
    getUsageDatabase(),
    `SELECT payload
     FROM audit_events
     WHERE session_id = ?
       AND event_type = 'tool.call'
       AND (? IS NULL OR timestamp >= ?)
     ORDER BY id ASC`,
    resolvedSessionId,
    normalizedSince,
    normalizedSince,
  );

  const counts = new Map<string, number>();
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload) as { toolName?: unknown };
      const toolName = String(payload.toolName || '').trim();
      if (!toolName) continue;
      counts.set(toolName, (counts.get(toolName) || 0) + 1);
    } catch {
      // Best effort only. Skip malformed audit payloads.
    }
  }

  return [...counts.entries()]
    .map(([toolName, count]) => ({ toolName, count }))
    .sort(
      (left, right) =>
        right.count - left.count || left.toolName.localeCompare(right.toolName),
    );
}

export interface ToolUsageSummary {
  toolName: string;
  callsSinceCutoff: number;
  lastUsedAt: string | null;
}

export function getToolUsageSummary(params?: {
  sinceTimestamp?: string | null;
}): ToolUsageSummary[] {
  const normalizedSince =
    typeof params?.sinceTimestamp === 'string' && params.sinceTimestamp.trim()
      ? params.sinceTimestamp.trim()
      : null;
  return queryAll<
    {
      toolName: string;
      callsSinceCutoff: number;
      lastUsedAt: string | null;
    },
    [string | null, string | null]
  >(
    getUsageDatabase(),
    `SELECT toolName, callsSinceCutoff, lastUsedAt
     FROM (
       SELECT
         TRIM(CAST(JSON_EXTRACT(payload, '$.toolName') AS TEXT)) AS toolName,
         SUM(CASE WHEN ? IS NULL OR timestamp >= ? THEN 1 ELSE 0 END) AS callsSinceCutoff,
         MAX(timestamp) AS lastUsedAt
       FROM audit_events
       WHERE event_type = 'tool.call'
         AND json_valid(payload)
       GROUP BY TRIM(CAST(JSON_EXTRACT(payload, '$.toolName') AS TEXT))
     )
     WHERE toolName != ''
     ORDER BY toolName ASC`,
    normalizedSince,
    normalizedSince,
  );
}

function extractToolFilePath(argumentsValue: unknown): string | null {
  if (!argumentsValue || typeof argumentsValue !== 'object') return null;
  const pathValue = (argumentsValue as Record<string, unknown>).path;
  if (typeof pathValue !== 'string') return null;
  const normalized = pathValue.trim().replace(/\\/g, '/');
  return normalized || null;
}

export function getSessionFileChangeCounts(
  sessionId: string,
  sinceTimestamp: string | null = null,
): {
  readCount: number;
  modifiedCount: number;
  createdCount: number;
  deletedCount: number;
} {
  const resolvedSessionId = resolveSessionIdCompat(sessionId);
  const normalizedSince =
    typeof sinceTimestamp === 'string' && sinceTimestamp.trim()
      ? sinceTimestamp.trim()
      : null;
  const rows = queryAll<
    Pick<StructuredAuditEntry, 'event_type' | 'payload'>,
    [string, string | null, string | null]
  >(
    getUsageDatabase(),
    `SELECT event_type, payload
     FROM audit_events
     WHERE session_id = ?
       AND event_type IN ('tool.call', 'tool.result')
       AND (? IS NULL OR timestamp >= ?)
     ORDER BY id ASC`,
    resolvedSessionId,
    normalizedSince,
    normalizedSince,
  );

  const toolCalls = new Map<
    string,
    {
      toolName: string;
      path: string | null;
    }
  >();
  const readPaths = new Set<string>();
  const modifiedPaths = new Set<string>();
  const createdPaths = new Set<string>();
  const deletedPaths = new Set<string>();

  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload) as {
        toolCallId?: unknown;
        toolName?: unknown;
        arguments?: unknown;
        isError?: unknown;
        blocked?: unknown;
      };
      const toolCallId = String(payload.toolCallId || '').trim();
      if (!toolCallId) continue;

      if (row.event_type === 'tool.call') {
        const toolName = String(payload.toolName || '').trim();
        if (!toolName) continue;
        toolCalls.set(toolCallId, {
          toolName,
          path: extractToolFilePath(payload.arguments),
        });
        continue;
      }

      if (payload.isError === true || payload.blocked === true) continue;
      const toolCall = toolCalls.get(toolCallId);
      if (!toolCall?.path) continue;

      switch (toolCall.toolName) {
        case 'read':
          readPaths.add(toolCall.path);
          break;
        case 'edit':
          modifiedPaths.add(toolCall.path);
          break;
        case 'write':
          createdPaths.add(toolCall.path);
          break;
        case 'delete':
          deletedPaths.add(toolCall.path);
          break;
        default:
          break;
      }
    } catch {
      // Best effort only. Skip malformed audit payloads.
    }
  }

  return {
    readCount: readPaths.size,
    modifiedCount: modifiedPaths.size,
    createdCount: createdPaths.size,
    deletedCount: deletedPaths.size,
  };
}

export function listUsageByModel(params?: {
  agentId?: string;
  window?: UsageWindow;
}): UsageModelAggregate[] {
  const whereClauses: string[] = [];
  const args: unknown[] = [];
  applyUsageFilters({
    whereClauses,
    args,
    agentId: params?.agentId,
    window: params?.window,
  });
  const where =
    whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
  const rows = queryAll<UsageModelAggregate>(
    getUsageDatabase(),
    `SELECT
       model,
       COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
       COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
       COALESCE(SUM(total_tokens), 0) AS total_tokens,
       COALESCE(SUM(cost_usd), 0.0) AS total_cost_usd,
       COUNT(*) AS call_count,
       COALESCE(SUM(tool_calls), 0) AS total_tool_calls
     FROM usage_events
     ${where}
     GROUP BY model
     ORDER BY total_tokens DESC, call_count DESC, total_cost_usd DESC`,
    ...args,
  );

  return rows.map((row) => ({
    model: row.model,
    total_input_tokens: normalizeUsageNumber(row.total_input_tokens),
    total_output_tokens: normalizeUsageNumber(row.total_output_tokens),
    total_tokens: normalizeUsageNumber(row.total_tokens),
    total_cost_usd: normalizeUsageCost(row.total_cost_usd),
    call_count: normalizeUsageNumber(row.call_count),
    total_tool_calls: normalizeUsageNumber(row.total_tool_calls),
  }));
}

export function listUsageByAgent(params?: {
  window?: UsageWindow;
}): UsageAgentAggregate[] {
  const whereClauses: string[] = [];
  const args: unknown[] = [];
  applyUsageFilters({
    whereClauses,
    args,
    window: params?.window,
  });
  const where =
    whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
  const rows = queryAll<UsageAgentAggregate>(
    getUsageDatabase(),
    `SELECT
       agent_id,
       COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
       COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
       COALESCE(SUM(total_tokens), 0) AS total_tokens,
       COALESCE(SUM(cost_usd), 0.0) AS total_cost_usd,
       COUNT(*) AS call_count,
       COALESCE(SUM(tool_calls), 0) AS total_tool_calls
     FROM usage_events
     ${where}
     GROUP BY agent_id
     ORDER BY total_cost_usd DESC, total_tokens DESC, call_count DESC`,
    ...args,
  );

  return rows.map((row) => ({
    agent_id: row.agent_id,
    total_input_tokens: normalizeUsageNumber(row.total_input_tokens),
    total_output_tokens: normalizeUsageNumber(row.total_output_tokens),
    total_tokens: normalizeUsageNumber(row.total_tokens),
    total_cost_usd: normalizeUsageCost(row.total_cost_usd),
    call_count: normalizeUsageNumber(row.call_count),
    total_tool_calls: normalizeUsageNumber(row.total_tool_calls),
  }));
}

export function listUsageByAgentRollups(): UsageAgentRollup[] {
  const rows = queryAll<UsageAgentRollup>(
    getUsageDatabase(),
    `SELECT
       agent_id,
       COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
       COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
       COALESCE(SUM(total_tokens), 0) AS total_tokens,
       COALESCE(SUM(cost_usd), 0.0) AS total_cost_usd,
       COALESCE(SUM(
         CASE
           WHEN timestamp >= datetime('now', 'start of month') THEN cost_usd
           ELSE 0
         END
       ), 0.0) AS monthly_cost_usd,
       COUNT(*) AS call_count,
       COALESCE(SUM(tool_calls), 0) AS total_tool_calls
     FROM usage_events
     GROUP BY agent_id
     ORDER BY total_cost_usd DESC, total_tokens DESC, call_count DESC`,
  );

  return rows.map((row) => ({
    agent_id: row.agent_id,
    total_input_tokens: normalizeUsageNumber(row.total_input_tokens),
    total_output_tokens: normalizeUsageNumber(row.total_output_tokens),
    total_tokens: normalizeUsageNumber(row.total_tokens),
    total_cost_usd: normalizeUsageCost(row.total_cost_usd),
    monthly_cost_usd: normalizeUsageCost(row.monthly_cost_usd),
    call_count: normalizeUsageNumber(row.call_count),
    total_tool_calls: normalizeUsageNumber(row.total_tool_calls),
  }));
}

export function listUsageBySession(params?: {
  window?: UsageWindow;
}): UsageSessionAggregate[] {
  const whereClauses: string[] = [];
  const args: unknown[] = [];
  applyUsageFilters({
    whereClauses,
    args,
    window: params?.window,
  });
  const where =
    whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
  const rows = queryAll<UsageSessionAggregate>(
    getUsageDatabase(),
    `SELECT
       session_id,
       COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
       COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
       COALESCE(SUM(total_tokens), 0) AS total_tokens,
       COALESCE(SUM(cost_usd), 0.0) AS total_cost_usd,
       COUNT(*) AS call_count,
       COALESCE(SUM(tool_calls), 0) AS total_tool_calls
     FROM usage_events
     ${where}
     GROUP BY session_id
     ORDER BY total_cost_usd DESC, total_tokens DESC, call_count DESC`,
    ...args,
  );

  return rows.map((row) => ({
    session_id: row.session_id,
    total_input_tokens: normalizeUsageNumber(row.total_input_tokens),
    total_output_tokens: normalizeUsageNumber(row.total_output_tokens),
    total_tokens: normalizeUsageNumber(row.total_tokens),
    total_cost_usd: normalizeUsageCost(row.total_cost_usd),
    call_count: normalizeUsageNumber(row.call_count),
    total_tool_calls: normalizeUsageNumber(row.total_tool_calls),
  }));
}

export function listUsageDailyBreakdown(params?: {
  agentId?: string;
  days?: number;
}): UsageDailyAggregate[] {
  const days = Math.max(1, Math.min(365, Math.floor(params?.days || 30)));
  const whereClauses: string[] = [
    `timestamp >= datetime('now', '-${days} days')`,
  ];
  const args: unknown[] = [];
  const agentId = params?.agentId?.trim();
  if (agentId) {
    whereClauses.push('agent_id = ?');
    args.push(agentId);
  }
  const rows = queryAll<UsageDailyAggregate>(
    getUsageDatabase(),
    `SELECT
       date(timestamp) AS day,
       COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
       COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
       COALESCE(SUM(total_tokens), 0) AS total_tokens,
       COALESCE(SUM(cost_usd), 0.0) AS total_cost_usd,
       COUNT(*) AS call_count,
       COALESCE(SUM(tool_calls), 0) AS total_tool_calls
     FROM usage_events
     WHERE ${whereClauses.join(' AND ')}
     GROUP BY day
     ORDER BY day ASC`,
    ...args,
  );

  return rows.map((row) => ({
    day: row.day,
    total_input_tokens: normalizeUsageNumber(row.total_input_tokens),
    total_output_tokens: normalizeUsageNumber(row.total_output_tokens),
    total_tokens: normalizeUsageNumber(row.total_tokens),
    total_cost_usd: normalizeUsageCost(row.total_cost_usd),
    call_count: normalizeUsageNumber(row.call_count),
    total_tool_calls: normalizeUsageNumber(row.total_tool_calls),
  }));
}

export interface MessageTrendDay {
  day: string;
  user_messages: number;
  assistant_messages: number;
  total_messages: number;
}

export function listMessageTrendByDay(params?: {
  days?: number;
}): MessageTrendDay[] {
  const days = Math.max(1, Math.min(365, Math.floor(params?.days || 30)));
  const dayOffset = days - 1;
  const rows = queryAll<{
    day: string;
    user_messages: number;
    assistant_messages: number;
    total_messages: number;
  }>(
    getUsageDatabase(),
    `SELECT
       date(created_at) AS day,
       SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) AS user_messages,
       SUM(CASE WHEN role = 'assistant' THEN 1 ELSE 0 END) AS assistant_messages,
       COUNT(*) AS total_messages
     FROM messages
     WHERE created_at >= datetime('now', 'start of day', '-${dayOffset} days')
     GROUP BY day
     ORDER BY day ASC`,
  );
  return rows.map((row) => ({
    day: String(row.day || ''),
    user_messages: normalizeUsageNumber(row.user_messages),
    assistant_messages: normalizeUsageNumber(row.assistant_messages),
    total_messages: normalizeUsageNumber(row.total_messages),
  }));
}

export interface SessionTrendDay {
  day: string;
  new_sessions: number;
  active_sessions: number;
}

export function listSessionTrendByDay(params?: {
  days?: number;
}): SessionTrendDay[] {
  const days = Math.max(1, Math.min(365, Math.floor(params?.days || 30)));
  const dayOffset = days - 1;
  const createdRows = queryAll<{ day: string; new_sessions: number }>(
    getUsageDatabase(),
    `SELECT date(created_at) AS day, COUNT(*) AS new_sessions
     FROM sessions
     WHERE created_at >= datetime('now', 'start of day', '-${dayOffset} days')
     GROUP BY day`,
  );
  const activeRows = queryAll<{ day: string; active_sessions: number }>(
    getUsageDatabase(),
    `SELECT date(created_at) AS day, COUNT(DISTINCT session_id) AS active_sessions
     FROM messages
     WHERE created_at >= datetime('now', 'start of day', '-${dayOffset} days')
     GROUP BY day`,
  );
  const byDay = new Map<string, SessionTrendDay>();
  for (const row of createdRows) {
    const day = String(row.day || '');
    if (!day) continue;
    byDay.set(day, {
      day,
      new_sessions: normalizeUsageNumber(row.new_sessions),
      active_sessions: 0,
    });
  }
  for (const row of activeRows) {
    const day = String(row.day || '');
    if (!day) continue;
    const existing = byDay.get(day);
    if (existing) {
      existing.active_sessions = normalizeUsageNumber(row.active_sessions);
    } else {
      byDay.set(day, {
        day,
        new_sessions: 0,
        active_sessions: normalizeUsageNumber(row.active_sessions),
      });
    }
  }
  return Array.from(byDay.values()).sort((a, b) =>
    a.day < b.day ? -1 : a.day > b.day ? 1 : 0,
  );
}

export interface ChannelStatsRow {
  channel_id: string;
  session_count: number;
  user_messages: number;
  assistant_messages: number;
  total_messages: number;
}

export function listStatsByChannel(params?: {
  days?: number;
}): ChannelStatsRow[] {
  const days = Math.max(1, Math.min(365, Math.floor(params?.days || 30)));
  const dayOffset = days - 1;
  const sessionRows = queryAll<{ channel_id: string; session_count: number }>(
    getUsageDatabase(),
    `SELECT COALESCE(channel_id, '') AS channel_id, COUNT(*) AS session_count
     FROM sessions
     WHERE last_active >= datetime('now', 'start of day', '-${dayOffset} days')
     GROUP BY channel_id`,
  );
  const messageRows = queryAll<{
    channel_id: string;
    user_messages: number;
    assistant_messages: number;
    total_messages: number;
  }>(
    getUsageDatabase(),
    `SELECT
       COALESCE(s.channel_id, '') AS channel_id,
       SUM(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END) AS user_messages,
       SUM(CASE WHEN m.role = 'assistant' THEN 1 ELSE 0 END) AS assistant_messages,
       COUNT(m.id) AS total_messages
     FROM messages m
     JOIN sessions s ON s.id = m.session_id
     WHERE m.created_at >= datetime('now', 'start of day', '-${dayOffset} days')
     GROUP BY s.channel_id`,
  );
  const byChannel = new Map<string, ChannelStatsRow>();
  for (const row of sessionRows) {
    const channelId = String(row.channel_id || '');
    byChannel.set(channelId, {
      channel_id: channelId,
      session_count: normalizeUsageNumber(row.session_count),
      user_messages: 0,
      assistant_messages: 0,
      total_messages: 0,
    });
  }
  for (const row of messageRows) {
    const channelId = String(row.channel_id || '');
    const existing = byChannel.get(channelId) || {
      channel_id: channelId,
      session_count: 0,
      user_messages: 0,
      assistant_messages: 0,
      total_messages: 0,
    };
    existing.user_messages = normalizeUsageNumber(row.user_messages);
    existing.assistant_messages = normalizeUsageNumber(row.assistant_messages);
    existing.total_messages = normalizeUsageNumber(row.total_messages);
    byChannel.set(channelId, existing);
  }
  return Array.from(byChannel.values()).sort(
    (a, b) =>
      b.total_messages - a.total_messages || b.session_count - a.session_count,
  );
}

export interface StatisticsTotals {
  new_sessions: number;
  active_sessions: number;
  total_messages: number;
  user_messages: number;
  assistant_messages: number;
}

export function getStatisticsTotals(params?: {
  days?: number;
}): StatisticsTotals {
  const days = Math.max(1, Math.min(365, Math.floor(params?.days || 30)));
  const dayOffset = days - 1;
  const sessionRow = queryOne<{ new_sessions: number }>(
    getUsageDatabase(),
    `SELECT COUNT(*) AS new_sessions
     FROM sessions
     WHERE created_at >= datetime('now', 'start of day', '-${dayOffset} days')`,
  );
  const activeRow = queryOne<{ active_sessions: number }>(
    getUsageDatabase(),
    `SELECT COUNT(DISTINCT session_id) AS active_sessions
     FROM messages
     WHERE created_at >= datetime('now', 'start of day', '-${dayOffset} days')`,
  );
  const messageRow = queryOne<{
    total_messages: number;
    user_messages: number;
    assistant_messages: number;
  }>(
    getUsageDatabase(),
    `SELECT
       COUNT(*) AS total_messages,
       SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) AS user_messages,
       SUM(CASE WHEN role = 'assistant' THEN 1 ELSE 0 END) AS assistant_messages
     FROM messages
     WHERE created_at >= datetime('now', 'start of day', '-${dayOffset} days')`,
  );
  return {
    new_sessions: normalizeUsageNumber(sessionRow?.new_sessions ?? 0),
    active_sessions: normalizeUsageNumber(activeRow?.active_sessions ?? 0),
    total_messages: normalizeUsageNumber(messageRow?.total_messages ?? 0),
    user_messages: normalizeUsageNumber(messageRow?.user_messages ?? 0),
    assistant_messages: normalizeUsageNumber(
      messageRow?.assistant_messages ?? 0,
    ),
  };
}
