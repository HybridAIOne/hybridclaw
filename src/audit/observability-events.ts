/**
 * Observability event mapping — turns one local audit row into the event shape
 * the platform ingest API accepts.
 *
 * Pure and per row: batching, cursors and tokens stay in
 * `observability-ingest.ts`. The event uid is the platform's idempotency key,
 * so its inputs (node, agent, session, seq, type, time, run) must stay stable.
 */
import { createHash } from 'node:crypto';
import { repairUnicodeForJson } from '#shared/unicode-utils.js';
import type { StructuredAuditEntry } from '../types/audit.js';

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Best effort fallback.
  }
  return {};
}

function readNullableString(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function readNullableInteger(
  payload: Record<string, unknown>,
  key: string,
): number | null {
  const value = payload[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function readNullableBoolean(
  payload: Record<string, unknown>,
  key: string,
): boolean | null {
  const value = payload[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return null;
}

function inferDenied(payload: Record<string, unknown>): boolean {
  if (typeof payload.denied === 'boolean') return payload.denied;
  if (payload.approved === false) return true;
  if (payload.allowed === false) return true;
  return false;
}

function enrichObservabilityPayload(
  eventType: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (eventType !== 'bot.set') return payload;
  if (typeof payload.modelChanged === 'boolean') return payload;

  const previousModel = readNullableString(payload, 'previousModel');
  const syncedModel = readNullableString(payload, 'syncedModel');
  return {
    ...payload,
    modelChanged: syncedModel ? previousModel !== syncedModel : false,
  };
}

function repairObservabilityEventUnicode(
  event: Record<string, unknown>,
): Record<string, unknown> {
  return repairUnicodeForJson(event) as Record<string, unknown>;
}

function buildEventUid(
  nodeId: string,
  agentId: string,
  row: StructuredAuditEntry,
): string {
  const raw = [
    nodeId,
    agentId,
    row.session_id,
    String(row.seq),
    row.event_type,
    row.timestamp,
    row.run_id,
  ].join('|');
  // lgtm[js/insufficient-password-hash] This digest is an event idempotency
  // key, not a credential or password verifier.
  return createHash('sha256').update(raw).digest('hex');
}

export function mapAuditRowToEvent(
  nodeId: string,
  agentId: string,
  row: StructuredAuditEntry,
): Record<string, unknown> {
  const payload = enrichObservabilityPayload(
    row.event_type,
    parsePayload(row.payload),
  );
  return repairObservabilityEventUnicode({
    session_id: row.session_id,
    run_id: row.run_id,
    parent_run_id: row.parent_run_id || null,
    seq: row.seq,
    event_type: row.event_type,
    event_timestamp: row.timestamp,
    payload,
    wire_hash: row.wire_hash,
    wire_prev_hash: row.wire_prev_hash || null,
    denied: inferDenied(payload),
    error_type: readNullableString(payload, 'errorType'),
    duration_ms: readNullableInteger(payload, 'durationMs'),
    model_calls: readNullableInteger(payload, 'modelCalls'),
    prompt_chars: readNullableInteger(payload, 'promptChars'),
    completion_chars: readNullableInteger(payload, 'completionChars'),
    prompt_tokens: readNullableInteger(payload, 'promptTokens'),
    completion_tokens: readNullableInteger(payload, 'completionTokens'),
    total_tokens: readNullableInteger(payload, 'totalTokens'),
    estimated_prompt_tokens: readNullableInteger(
      payload,
      'estimatedPromptTokens',
    ),
    estimated_completion_tokens: readNullableInteger(
      payload,
      'estimatedCompletionTokens',
    ),
    estimated_total_tokens: readNullableInteger(
      payload,
      'estimatedTotalTokens',
    ),
    api_usage_available: readNullableBoolean(payload, 'apiUsageAvailable'),
    api_prompt_tokens: readNullableInteger(payload, 'apiPromptTokens'),
    api_completion_tokens: readNullableInteger(payload, 'apiCompletionTokens'),
    api_total_tokens: readNullableInteger(payload, 'apiTotalTokens'),
    api_cache_read_tokens: readNullableInteger(payload, 'apiCacheReadTokens'),
    api_cache_write_tokens: readNullableInteger(payload, 'apiCacheWriteTokens'),
    event_uid: buildEventUid(nodeId, agentId, row),
  });
}
