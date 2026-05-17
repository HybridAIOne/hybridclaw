import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import { recordUsageEvent } from '../memory/db.js';

export type FaxProvider =
  | 'sinch'
  | 'phaxio'
  | 'telekom-cloud-fax'
  | 'vodafone-mail2fax';

export interface FaxAuditBase {
  sessionId: string;
  runId?: string;
  parentRunId?: string;
  provider: FaxProvider | string;
  providerMessageId?: string | null;
  recipientNumber: string;
  senderNumber?: string | null;
  pageCount?: number | null;
  documentUrl?: string | null;
}

export interface FaxFailedAudit extends FaxAuditBase {
  errorType?: string | null;
  errorCode?: string | number | null;
  errorMessage?: string | null;
  retryable?: boolean;
}

export interface FaxUsageInput {
  sessionId: string;
  agentId: string;
  provider: FaxProvider | string;
  pageCount: number;
  costUsd?: number;
  timestamp?: string;
}

function normalizePageCount(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : null;
}

function buildPayload(params: FaxAuditBase): Record<string, unknown> {
  return {
    provider: params.provider,
    providerMessageId: params.providerMessageId || null,
    recipientNumber: params.recipientNumber,
    senderNumber: params.senderNumber || null,
    pageCount: normalizePageCount(params.pageCount),
    documentUrl: params.documentUrl || null,
  };
}

function recordFaxAudit(
  eventType: 'fax.send.start' | 'fax.send.delivered' | 'fax.send.failed',
  params: FaxAuditBase,
  extra?: Record<string, unknown>,
): string {
  const runId = params.runId || makeAuditRunId('fax');
  recordAuditEvent({
    sessionId: params.sessionId,
    runId,
    parentRunId: params.parentRunId,
    event: {
      type: eventType,
      ...buildPayload(params),
      ...(extra || {}),
    },
  });
  return runId;
}

export function recordFaxSendStart(params: FaxAuditBase): string {
  return recordFaxAudit('fax.send.start', params);
}

export function recordFaxSendDelivered(params: FaxAuditBase): string {
  return recordFaxAudit('fax.send.delivered', params);
}

export function recordFaxSendFailed(params: FaxFailedAudit): string {
  return recordFaxAudit('fax.send.failed', params, {
    errorType: params.errorType || null,
    errorCode: params.errorCode ?? null,
    errorMessage: params.errorMessage || null,
    retryable: params.retryable === true,
  });
}

export function recordFaxUsageEvent(params: FaxUsageInput): void {
  const pageCount = normalizePageCount(params.pageCount);
  if (!pageCount) return;
  recordUsageEvent({
    sessionId: params.sessionId,
    agentId: params.agentId,
    model: `fax:${params.provider}`,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    toolCalls: 1,
    costUsd: params.costUsd,
    timestamp: params.timestamp,
    billableUnit: 'fax-page',
    billableQuantity: pageCount,
  });
}
