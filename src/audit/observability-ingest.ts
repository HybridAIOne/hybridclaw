import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';

import {
  APP_VERSION,
  HYBRIDAI_API_KEY,
  HYBRIDAI_CHATBOT_ID,
  OBSERVABILITY_AGENT_ID,
  OBSERVABILITY_BASE_URL,
  OBSERVABILITY_BATCH_MAX_EVENTS,
  OBSERVABILITY_BOT_ID,
  OBSERVABILITY_ENABLED,
  OBSERVABILITY_ENVIRONMENT,
  OBSERVABILITY_FLUSH_INTERVAL_MS,
  OBSERVABILITY_INGEST_PATH,
  OBSERVABILITY_LABEL,
} from '../config/config.js';
import { logger } from '../logger.js';
import {
  deleteObservabilityIngestToken,
  getAnyChatbotId,
  getObservabilityIngestToken,
  getObservabilityOffset,
  getStructuredAuditAfterId,
  setObservabilityIngestToken,
  setObservabilityOffset,
} from '../memory/db.js';
import type { StructuredAuditEntry } from '../types.js';

const PLATFORM_MAX_EVENTS = 1_000;
const PLATFORM_MAX_PAYLOAD_BYTES = 2_000_000;
const FETCH_LIMIT_FACTOR = 4;
const TOKEN_ADMIN_PATH = '/api/v1/agent-observability/ingest-token:ensure';

interface ResolvedIngestConfig {
  enabled: boolean;
  ingestUrl: string;
  tokenAdminUrl: string;
  apiKey: string;
  botId: string;
  agentId: string;
  label: string;
  environment: string;
  flushIntervalMs: number;
  batchMaxEvents: number;
  version: string;
}

interface TokenGrantPayload {
  status?: unknown;
  success?: unknown;
  created?: unknown;
  rotated?: unknown;
  token?: unknown;
  message?: unknown;
}

interface TokenGrantResult {
  ok: boolean;
  statusCode: number;
  created: boolean;
  rotated: boolean;
  token: string | null;
  message: string | null;
  errorText: string;
}

interface TokenResolutionResult {
  ok: boolean;
  token: string | null;
  source: 'cache' | 'created' | 'ensured' | null;
  reason: string | null;
}

interface PreparedBatch {
  payloadText: string | null;
  eventCount: number;
  lastEventId: number;
  droppedUntilEventId: number;
  droppedEventIds: number[];
}

interface IngestResponsePayload {
  status?: unknown;
  inserted_events?: unknown;
  duplicate_events?: unknown;
  broken_chain_events?: unknown;
}

interface IngestResult {
  ok: boolean;
  statusCode: number;
  insertedEvents: number;
  duplicateEvents: number;
  brokenChainEvents: number;
  errorText: string;
}

export interface ObservabilityIngestState {
  enabled: boolean;
  running: boolean;
  paused: boolean;
  reason: string | null;
  streamKey: string | null;
  lastCursor: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
}

const ingestState: ObservabilityIngestState = {
  enabled: false,
  running: false,
  paused: false,
  reason: null,
  streamKey: null,
  lastCursor: 0,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastError: null,
};

let timer: ReturnType<typeof setInterval> | null = null;
let flushInProgress = false;

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return Math.floor(value);
}

function normalizeIngestUrl(baseUrl: string, ingestPath: string): string {
  const trimmedPath = ingestPath.trim();
  if (/^https?:\/\//i.test(trimmedPath)) return trimmedPath;
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  const normalizedPath = trimmedPath.startsWith('/')
    ? trimmedPath
    : `/${trimmedPath}`;
  return `${normalizedBase}${normalizedPath}`;
}

function resolveConfig(): ResolvedIngestConfig {
  const botId =
    OBSERVABILITY_BOT_ID.trim() ||
    HYBRIDAI_CHATBOT_ID.trim() ||
    getAnyChatbotId() ||
    '';
  const label = OBSERVABILITY_LABEL.trim() || os.hostname();
  const environment = OBSERVABILITY_ENVIRONMENT.trim() || 'prod';
  const batchMaxEvents = clampInteger(
    OBSERVABILITY_BATCH_MAX_EVENTS,
    1,
    PLATFORM_MAX_EVENTS,
  );
  const flushIntervalMs = clampInteger(
    OBSERVABILITY_FLUSH_INTERVAL_MS,
    1_000,
    3_600_000,
  );

  return {
    enabled: OBSERVABILITY_ENABLED,
    ingestUrl: normalizeIngestUrl(
      OBSERVABILITY_BASE_URL,
      OBSERVABILITY_INGEST_PATH,
    ),
    tokenAdminUrl: normalizeIngestUrl(OBSERVABILITY_BASE_URL, TOKEN_ADMIN_PATH),
    apiKey: HYBRIDAI_API_KEY.trim(),
    botId,
    agentId: OBSERVABILITY_AGENT_ID.trim() || 'agent_main',
    label,
    environment,
    flushIntervalMs,
    batchMaxEvents,
    version: APP_VERSION,
  };
}

function validateConfig(config: ResolvedIngestConfig): {
  ok: boolean;
  reason: string | null;
} {
  if (!config.enabled) return { ok: false, reason: 'disabled' };
  if (!config.botId)
    return {
      ok: false,
      reason: 'missing observability.botId (or hybridai.defaultChatbotId)',
    };
  if (!config.agentId)
    return { ok: false, reason: 'missing observability.agentId' };
  if (!config.apiKey) {
    return {
      ok: false,
      reason:
        'missing HYBRIDAI_API_KEY (needed to auto-fetch observability ingest token)',
    };
  }
  return { ok: true, reason: null };
}

function buildStreamKey(config: ResolvedIngestConfig): string {
  return `${config.ingestUrl}|${config.botId}|${config.agentId}`;
}

function buildTokenCacheKey(config: ResolvedIngestConfig): string {
  return `${config.tokenAdminUrl}|${config.botId}`;
}

function parseBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  }
  return false;
}

function parseMessage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

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

function buildEventUid(
  config: ResolvedIngestConfig,
  row: StructuredAuditEntry,
): string {
  const raw = [
    config.botId,
    config.agentId,
    row.session_id,
    String(row.seq),
    row.event_type,
    row.timestamp,
    row.run_id,
  ].join('|');
  return createHash('sha256').update(raw).digest('hex');
}

function mapAuditRowToEvent(
  config: ResolvedIngestConfig,
  row: StructuredAuditEntry,
): Record<string, unknown> {
  const payload = parsePayload(row.payload);
  return {
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
    event_uid: buildEventUid(config, row),
  };
}

function buildBatchPayloadText(
  config: ResolvedIngestConfig,
  events: Record<string, unknown>[],
  batchId: string,
): string {
  return JSON.stringify({
    bot_id: config.botId,
    agent_id: config.agentId,
    batch_id: batchId,
    sent_at: new Date().toISOString(),
    label: config.label,
    version: config.version,
    environment: config.environment,
    events,
  });
}

function prepareBatch(
  config: ResolvedIngestConfig,
  rows: StructuredAuditEntry[],
  currentCursor: number,
): PreparedBatch {
  const selectedEvents: Record<string, unknown>[] = [];
  const droppedEventIds: number[] = [];
  let lastEventId = currentCursor;
  let droppedUntilEventId = currentCursor;
  const batchId = `batch_${Date.now()}_${randomUUID().slice(0, 8)}`;

  for (const row of rows) {
    if (selectedEvents.length >= config.batchMaxEvents) break;
    if (selectedEvents.length >= PLATFORM_MAX_EVENTS) break;

    const nextEvent = mapAuditRowToEvent(config, row);
    const candidateEvents = [...selectedEvents, nextEvent];
    const payloadText = buildBatchPayloadText(config, candidateEvents, batchId);
    const payloadSize = Buffer.byteLength(payloadText, 'utf8');
    if (payloadSize > PLATFORM_MAX_PAYLOAD_BYTES) {
      if (selectedEvents.length === 0) {
        droppedEventIds.push(row.id);
        lastEventId = row.id;
        droppedUntilEventId = row.id;
        continue;
      }
      break;
    }

    selectedEvents.push(nextEvent);
    lastEventId = row.id;
  }

  if (selectedEvents.length === 0) {
    return {
      payloadText: null,
      eventCount: 0,
      lastEventId,
      droppedUntilEventId,
      droppedEventIds,
    };
  }

  return {
    payloadText: buildBatchPayloadText(config, selectedEvents, batchId),
    eventCount: selectedEvents.length,
    lastEventId,
    droppedUntilEventId,
    droppedEventIds,
  };
}

function parseCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }
  return 0;
}

function formatGrantError(prefix: string, grant: TokenGrantResult): string {
  if (grant.errorText) return `${prefix}: ${grant.errorText}`;
  return `${prefix}: HTTP ${grant.statusCode}`;
}

async function requestIngestToken(
  config: ResolvedIngestConfig,
  rotate = false,
): Promise<TokenGrantResult> {
  let response: Response;
  try {
    response = await fetch(config.tokenAdminUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        bot_id: config.botId,
        ...(rotate ? { rotate: true } : {}),
      }),
    });
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      statusCode: 0,
      created: false,
      rotated: rotate,
      token: null,
      message: null,
      errorText: text,
    };
  }

  const rawText = (await response.text().catch(() => '')).trim();
  let payload: TokenGrantPayload = {};
  if (rawText) {
    try {
      payload = JSON.parse(rawText) as TokenGrantPayload;
    } catch {
      payload = {};
    }
  }

  if (!response.ok) {
    return {
      ok: false,
      statusCode: response.status,
      created: false,
      rotated: rotate,
      token: null,
      message: parseMessage(payload.message),
      errorText:
        parseMessage(payload.message) ||
        rawText ||
        `${response.status} ${response.statusText}`,
    };
  }

  const statusText = parseMessage(payload.status)?.toLowerCase() || null;
  const successFlagPresent = payload.success != null;
  const success = successFlagPresent
    ? parseBoolean(payload.success)
    : statusText === null || statusText === 'ok' || statusText === 'accepted';
  const token = parseMessage(payload.token);
  const created = parseBoolean(payload.created);
  const rotated = parseBoolean(payload.rotated) || rotate;
  const message = parseMessage(payload.message);

  if (!success) {
    return {
      ok: false,
      statusCode: response.status,
      created,
      rotated,
      token: null,
      message,
      errorText: message || 'token endpoint returned success=false',
    };
  }

  return {
    ok: true,
    statusCode: response.status,
    created,
    rotated,
    token,
    message,
    errorText: token ? '' : rawText || '',
  };
}

async function resolveIngestToken(
  config: ResolvedIngestConfig,
  forceRefresh = false,
): Promise<TokenResolutionResult> {
  if (!config.apiKey) {
    return {
      ok: false,
      token: null,
      source: null,
      reason:
        'missing HYBRIDAI_API_KEY (needed to auto-fetch observability ingest token)',
    };
  }

  const tokenKey = buildTokenCacheKey(config);
  if (!forceRefresh) {
    const cached = getObservabilityIngestToken(tokenKey);
    if (cached)
      return { ok: true, token: cached, source: 'cache', reason: null };
  } else {
    deleteObservabilityIngestToken(tokenKey);
    const rotated = await requestIngestToken(config, true);
    if (!rotated.ok) {
      return {
        ok: false,
        token: null,
        source: null,
        reason: formatGrantError(
          'failed to rotate observability ingest token',
          rotated,
        ),
      };
    }
    if (!rotated.token) {
      const message =
        rotated.message ||
        rotated.errorText ||
        'token rotate endpoint returned no token';
      return {
        ok: false,
        token: null,
        source: null,
        reason: message,
      };
    }
    setObservabilityIngestToken(tokenKey, rotated.token);
    return {
      ok: true,
      token: rotated.token,
      source: 'created',
      reason: null,
    };
  }

  const granted = await requestIngestToken(config);
  if (!granted.ok) {
    return {
      ok: false,
      token: null,
      source: null,
      reason: formatGrantError(
        'failed to ensure observability ingest token',
        granted,
      ),
    };
  }
  if (!granted.token) {
    const rotated = await requestIngestToken(config, true);
    if (!rotated.ok) {
      return {
        ok: false,
        token: null,
        source: null,
        reason: formatGrantError(
          'failed to rotate observability ingest token',
          rotated,
        ),
      };
    }
    if (!rotated.token) {
      const message =
        rotated.message ||
        rotated.errorText ||
        granted.message ||
        granted.errorText ||
        'token rotate endpoint returned no token';
      return {
        ok: false,
        token: null,
        source: null,
        reason: message,
      };
    }
    setObservabilityIngestToken(tokenKey, rotated.token);
    return {
      ok: true,
      token: rotated.token,
      source: 'created',
      reason: null,
    };
  }

  setObservabilityIngestToken(tokenKey, granted.token);
  return {
    ok: true,
    token: granted.token,
    source: granted.created ? 'created' : 'ensured',
    reason: null,
  };
}

async function postBatch(
  config: ResolvedIngestConfig,
  token: string,
  payloadText: string,
): Promise<IngestResult> {
  let response: Response;
  try {
    response = await fetch(config.ingestUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: payloadText,
    });
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      statusCode: 0,
      insertedEvents: 0,
      duplicateEvents: 0,
      brokenChainEvents: 0,
      errorText: text,
    };
  }

  const rawText = (await response.text().catch(() => '')).trim();
  if (!response.ok) {
    return {
      ok: false,
      statusCode: response.status,
      insertedEvents: 0,
      duplicateEvents: 0,
      brokenChainEvents: 0,
      errorText: rawText || `${response.status} ${response.statusText}`,
    };
  }

  let payload: IngestResponsePayload = {};
  if (rawText) {
    try {
      payload = JSON.parse(rawText) as IngestResponsePayload;
    } catch {
      payload = {};
    }
  }

  return {
    ok: true,
    statusCode: response.status,
    insertedEvents: parseCount(payload.inserted_events),
    duplicateEvents: parseCount(payload.duplicate_events),
    brokenChainEvents: parseCount(payload.broken_chain_events),
    errorText: '',
  };
}

function isPauseStatus(statusCode: number): boolean {
  return (
    statusCode === 400 ||
    statusCode === 401 ||
    statusCode === 403 ||
    statusCode === 413
  );
}

async function flushObservability(reason: string): Promise<void> {
  if (flushInProgress) return;
  flushInProgress = true;
  ingestState.running = true;

  try {
    const config = resolveConfig();
    ingestState.enabled = config.enabled;
    ingestState.streamKey = null;

    const validation = validateConfig(config);
    if (!validation.ok) {
      ingestState.reason = validation.reason;
      return;
    }
    ingestState.reason = null;
    if (ingestState.paused) return;

    const initialToken = await resolveIngestToken(config);
    if (!initialToken.ok || !initialToken.token) {
      ingestState.reason =
        initialToken.reason || 'failed to resolve observability ingest token';
      ingestState.lastFailureAt = new Date().toISOString();
      ingestState.lastError = ingestState.reason;
      logger.warn(
        {
          reason,
          tokenReason: ingestState.reason,
        },
        'Observability ingest token unavailable',
      );
      return;
    }
    let activeToken = initialToken.token;

    const streamKey = buildStreamKey(config);
    ingestState.streamKey = streamKey;
    let cursor = getObservabilityOffset(streamKey);
    ingestState.lastCursor = cursor;
    const fetchLimit = clampInteger(
      config.batchMaxEvents * FETCH_LIMIT_FACTOR,
      config.batchMaxEvents,
      5_000,
    );

    while (true) {
      const rows = getStructuredAuditAfterId(cursor, fetchLimit);
      if (rows.length === 0) break;

      const batch = prepareBatch(config, rows, cursor);
      if (batch.droppedEventIds.length > 0) {
        setObservabilityOffset(streamKey, batch.droppedUntilEventId);
        cursor = batch.droppedUntilEventId;
        ingestState.lastCursor = cursor;
        logger.warn(
          {
            droppedEvents: batch.droppedEventIds.length,
            droppedEventIds: batch.droppedEventIds,
            streamKey,
          },
          'Dropped oversized observability events while batching',
        );
      }

      if (!batch.payloadText || batch.eventCount === 0) {
        if (batch.lastEventId <= cursor) break;
        continue;
      }

      let result = await postBatch(config, activeToken, batch.payloadText);
      if (
        !result.ok &&
        (result.statusCode === 401 || result.statusCode === 403)
      ) {
        const refreshed = await resolveIngestToken(config, true);
        if (refreshed.ok && refreshed.token) {
          activeToken = refreshed.token;
          logger.warn(
            {
              reason,
              streamKey,
              statusCode: result.statusCode,
            },
            'Observability ingest auth failed; refreshed ingest token and retrying batch',
          );
          result = await postBatch(config, activeToken, batch.payloadText);
        } else {
          const refreshReason =
            refreshed.reason || 'unknown token refresh failure';
          result = {
            ...result,
            errorText: `${result.errorText} | token refresh failed: ${refreshReason}`,
          };
        }
      }

      if (!result.ok) {
        ingestState.lastFailureAt = new Date().toISOString();
        ingestState.lastError = result.errorText;
        logger.warn(
          {
            reason,
            streamKey,
            statusCode: result.statusCode || undefined,
            error: result.errorText,
            cursor,
            batchEvents: batch.eventCount,
          },
          'Observability ingest push failed',
        );
        if (isPauseStatus(result.statusCode)) {
          ingestState.paused = true;
          ingestState.reason = `paused after status ${result.statusCode}`;
          logger.error(
            {
              streamKey,
              statusCode: result.statusCode,
            },
            'Observability ingest paused; fix configuration/token and restart gateway',
          );
        }
        break;
      }

      setObservabilityOffset(streamKey, batch.lastEventId);
      cursor = batch.lastEventId;
      ingestState.lastCursor = cursor;
      ingestState.lastSuccessAt = new Date().toISOString();
      ingestState.lastError = null;
      logger.debug(
        {
          reason,
          streamKey,
          batchEvents: batch.eventCount,
          insertedEvents: result.insertedEvents,
          duplicateEvents: result.duplicateEvents,
          brokenChainEvents: result.brokenChainEvents,
          cursor,
        },
        'Observability ingest push succeeded',
      );
    }
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    ingestState.lastFailureAt = new Date().toISOString();
    ingestState.lastError = text;
    logger.warn({ reason, error: text }, 'Observability ingest flush crashed');
  } finally {
    flushInProgress = false;
    ingestState.running = false;
  }
}

export function startObservabilityIngest(): void {
  stopObservabilityIngest();
  ingestState.paused = false;
  ingestState.reason = null;
  ingestState.lastError = null;

  const config = resolveConfig();
  ingestState.enabled = config.enabled;
  const validation = validateConfig(config);
  if (!validation.ok) {
    ingestState.reason = validation.reason;
    if (config.enabled) {
      logger.warn(
        { reason: validation.reason },
        'Observability ingest not started (will retry each flush interval)',
      );
    }
  }

  timer = setInterval(() => {
    void flushObservability('interval');
  }, config.flushIntervalMs);

  if (validation.ok) {
    void flushObservability('startup');
  }

  logger.info(
    {
      ingestUrl: config.ingestUrl,
      botId: config.botId || '(pending)',
      agentId: config.agentId,
      flushIntervalMs: config.flushIntervalMs,
      batchMaxEvents: config.batchMaxEvents,
      deferredStart: !validation.ok,
    },
    validation.ok
      ? 'Observability ingest started'
      : 'Observability ingest timer started (waiting for botId)',
  );
}

export function stopObservabilityIngest(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  ingestState.running = false;
}

export function getObservabilityIngestState(): ObservabilityIngestState {
  return { ...ingestState };
}
