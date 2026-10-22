/**
 * Observability push — forwards local audit rows to the platform ingest API.
 *
 * The stream is keyed by this install's node id, not by bot or agent; each
 * batch carries the one agent its sessions belong to. NOT the audit trail
 * itself (`audit-trail.ts` owns the hash chain this module only relays).
 */
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { parseBooleanWithDefault } from '#shared/boolean-utils.js';
import {
  APP_VERSION,
  HYBRIDAI_API_KEY,
  HYBRIDAI_CHATBOT_ID,
  OBSERVABILITY_BASE_URL,
  OBSERVABILITY_BATCH_MAX_EVENTS,
  OBSERVABILITY_BOT_ID,
  OBSERVABILITY_ENABLED,
  OBSERVABILITY_ENVIRONMENT,
  OBSERVABILITY_FLUSH_INTERVAL_MS,
  OBSERVABILITY_INGEST_PATH,
  OBSERVABILITY_LABEL,
} from '../config/config.js';
import { resolveDefaultAgentId } from '../config/runtime-config.js';
import { resolveLocalInstanceId } from '../identity/agent-id.js';
import { logger } from '../logger.js';
import { getStructuredAuditAfterId } from '../memory/audit.js';
import {
  deleteObservabilityIngestToken,
  getLatestObservabilityOffsetWithPrefix,
  getObservabilityIngestToken,
  getObservabilityOffset,
  setObservabilityIngestToken,
  setObservabilityOffset,
} from '../memory/observability-store.js';
import { getAnyChatbotId } from '../memory/sessions.js';
import { parseSessionKey } from '../session/session-key.js';
import type { StructuredAuditEntry } from '../types/audit.js';
import { SlidingWindowRateLimiter } from '../utils/rate-limiter.js';
import {
  describeExpectedTransportError,
  isExpectedTransportError,
} from '../utils/transport-errors.js';
import { mapAuditRowToEvent } from './observability-events.js';

const PLATFORM_MAX_EVENTS = 1_000;
const PLATFORM_MAX_PAYLOAD_BYTES = 2_000_000;
const FETCH_LIMIT_FACTOR = 4;
const TOKEN_ADMIN_PATH = '/api/v1/agent-observability/ingest-token:ensure';
const OBSERVABILITY_TRANSIENT_WARN_WINDOW_MS = 60_000;
const OBSERVABILITY_TRANSIENT_WARN_LIMIT = 1;

interface ResolvedIngestConfig {
  enabled: boolean;
  ingestUrl: string;
  tokenAdminUrl: string;
  apiKey: string;
  botId: string;
  nodeId: string;
  defaultAgentId: string;
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
  statusCode?: number;
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
let flushGeneration = 0;
// Halved after each HTTP 500 so one event the server cannot store is isolated and skipped.
let failingBatchMaxEvents: number | null = null;
const transientObservabilityWarnLimiter = new SlidingWindowRateLimiter(
  OBSERVABILITY_TRANSIENT_WARN_WINDOW_MS,
);

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
    nodeId: resolveLocalInstanceId(),
    defaultAgentId: resolveDefaultAgentId(),
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
  return `${config.ingestUrl}|${config.nodeId}`;
}

function buildTokenCacheKey(config: ResolvedIngestConfig): string {
  return `${config.tokenAdminUrl}|${config.nodeId}`;
}

function agentIdForRow(
  config: ResolvedIngestConfig,
  row: StructuredAuditEntry,
): string {
  return parseSessionKey(row.session_id)?.agentId || config.defaultAgentId;
}

function parseBoolean(value: unknown): boolean {
  return parseBooleanWithDefault(value, false);
}

function parseMessage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function buildBatchPayloadText(
  config: ResolvedIngestConfig,
  agentId: string,
  events: Record<string, unknown>[],
  batchId: string,
): string {
  return JSON.stringify({
    bot_id: config.botId,
    agent_id: agentId,
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
  maxEvents: number,
): PreparedBatch {
  const selectedEvents: Record<string, unknown>[] = [];
  const droppedEventIds: number[] = [];
  let lastEventId = currentCursor;
  let droppedUntilEventId = currentCursor;
  const batchId = `batch_${Date.now()}_${randomUUID().slice(0, 8)}`;
  // One agent per batch, ending where another agent's row starts, so the cursor stays a prefix.
  let agentId = '';

  for (const row of rows) {
    if (selectedEvents.length >= maxEvents) break;
    if (selectedEvents.length >= PLATFORM_MAX_EVENTS) break;
    const rowAgentId = agentIdForRow(config, row);
    if (agentId && rowAgentId !== agentId) break;

    const nextEvent = mapAuditRowToEvent(config.nodeId, rowAgentId, row);
    const candidateEvents = [...selectedEvents, nextEvent];
    const payloadText = buildBatchPayloadText(
      config,
      rowAgentId,
      candidateEvents,
      batchId,
    );
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
    agentId = rowAgentId;
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
    payloadText: buildBatchPayloadText(
      config,
      agentId,
      selectedEvents,
      batchId,
    ),
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
        node_id: config.nodeId,
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
    // Tokens do not expire; a 401/403 from ingest forces the refresh below.
    const cached = getObservabilityIngestToken(tokenKey);
    if (cached) {
      return { ok: true, token: cached, source: 'cache', reason: null };
    }
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
        statusCode: rotated.statusCode,
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
      statusCode: granted.statusCode,
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
        statusCode: rotated.statusCode,
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

function resolveObservabilityHost(ingestUrl: string): string {
  try {
    return new URL(ingestUrl).hostname || '';
  } catch {
    return '';
  }
}

function isPauseStatus(statusCode: number): boolean {
  return (
    statusCode === 400 ||
    statusCode === 401 ||
    statusCode === 403 ||
    statusCode === 413
  );
}

function pauseIngest(statusCode: number, streamKey: string | null): void {
  ingestState.paused = true;
  ingestState.reason = `paused after status ${statusCode}`;
  logger.error(
    { streamKey, statusCode },
    'Observability ingest paused; fix configuration/token and restart gateway',
  );
}

async function flushObservability(reason: string): Promise<void> {
  const generation = flushGeneration;
  if (flushInProgress) return;
  flushInProgress = true;
  ingestState.running = true;

  try {
    const config = resolveConfig();
    if (generation !== flushGeneration) return;
    ingestState.enabled = config.enabled;
    ingestState.streamKey = null;

    const validation = validateConfig(config);
    if (!validation.ok) {
      if (generation !== flushGeneration) return;
      ingestState.reason = validation.reason;
      return;
    }
    ingestState.reason = null;
    if (ingestState.paused) return;

    const initialToken = await resolveIngestToken(config);
    if (generation !== flushGeneration) return;
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
      // A rejected API key fails identically every flush; retry on restart.
      if (initialToken.statusCode && isPauseStatus(initialToken.statusCode)) {
        pauseIngest(initialToken.statusCode, null);
      }
      return;
    }
    let activeToken = initialToken.token;

    const streamKey = buildStreamKey(config);
    const observabilityHost = resolveObservabilityHost(config.ingestUrl);
    ingestState.streamKey = streamKey;
    let cursor =
      getObservabilityOffset(streamKey) ||
      // compat: remove after v0.42 — resume the stream keyed by bot and agent instead of re-sending history.
      getLatestObservabilityOffsetWithPrefix(`${config.ingestUrl}|`);
    ingestState.lastCursor = cursor;
    const fetchLimit = clampInteger(
      config.batchMaxEvents * FETCH_LIMIT_FACTOR,
      config.batchMaxEvents,
      5_000,
    );

    while (true) {
      if (generation !== flushGeneration) return;
      const rows = getStructuredAuditAfterId(cursor, fetchLimit);
      if (rows.length === 0) break;

      const batch = prepareBatch(
        config,
        rows,
        cursor,
        failingBatchMaxEvents ?? config.batchMaxEvents,
      );
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
      if (generation !== flushGeneration) return;
      if (
        !result.ok &&
        (result.statusCode === 401 || result.statusCode === 403)
      ) {
        const refreshed = await resolveIngestToken(config, true);
        if (generation !== flushGeneration) return;
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
          if (generation !== flushGeneration) return;
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
        if (
          result.statusCode === 0 &&
          isExpectedTransportError(result.errorText)
        ) {
          const transientMessage = `${describeExpectedTransportError(result.errorText, 'Observability ingest', observabilityHost)} Events will be retried automatically.`;
          if (
            transientObservabilityWarnLimiter.check(
              `${streamKey}:${transientMessage}`,
              OBSERVABILITY_TRANSIENT_WARN_LIMIT,
            ).allowed
          ) {
            logger.warn(
              {
                reason,
                streamKey,
                cursor,
                batchEvents: batch.eventCount,
              },
              transientMessage,
            );
          }
        } else {
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
        }
        if (isPauseStatus(result.statusCode)) {
          pauseIngest(result.statusCode, streamKey);
        }
        if (result.statusCode === 500) {
          if (batch.eventCount === 1) {
            setObservabilityOffset(streamKey, batch.lastEventId);
            cursor = batch.lastEventId;
            ingestState.lastCursor = cursor;
            failingBatchMaxEvents = null;
            logger.warn(
              { streamKey, droppedEventId: batch.lastEventId },
              'Dropped observability event the server failed to ingest',
            );
          } else {
            failingBatchMaxEvents = Math.ceil(batch.eventCount / 2);
          }
        }
        break;
      }

      if (failingBatchMaxEvents !== null) {
        const doubled = failingBatchMaxEvents * 2;
        failingBatchMaxEvents =
          doubled >= config.batchMaxEvents ? null : doubled;
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
    if (generation !== flushGeneration) return;
    const text = err instanceof Error ? err.message : String(err);
    ingestState.lastFailureAt = new Date().toISOString();
    ingestState.lastError = text;
    logger.warn({ reason, error: text }, 'Observability ingest flush crashed');
  } finally {
    if (generation === flushGeneration) {
      flushInProgress = false;
      ingestState.running = false;
    }
  }
}

export function startObservabilityIngest(): void {
  stopObservabilityIngest();
  failingBatchMaxEvents = null;
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
      nodeId: config.nodeId,
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
  flushGeneration += 1;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  flushInProgress = false;
  ingestState.running = false;
}

export function getObservabilityIngestState(): ObservabilityIngestState {
  return { ...ingestState };
}
