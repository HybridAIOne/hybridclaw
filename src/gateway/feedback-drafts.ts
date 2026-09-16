/**
 * Feedback drafts — agent-authored bug/idea reports about HybridClaw that
 * queue locally until an operator reviews and sends them.
 *
 * Flow: the container `report_feedback` tool → `POST /api/feedback/draft` →
 * `createFeedbackDraft` (validate, redact, enrich, persist, audit). Operators
 * then use `/feedback list|view|send|discard`. `submitFeedbackDraft` forwards
 * the reviewed draft to the HybridAI backend; a transcript excerpt is only
 * attached when the operator asks for it explicitly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FEEDBACK_DRAFT_MAX_QUEUED_PER_SESSION,
  REPORT_FEEDBACK_TOOL_NAME,
  validateFeedbackDraftInput,
} from '../../container/shared/feedback-drafts.js';
import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import {
  getHybridAIApiKey,
  getHybridAIAuthStatus,
} from '../auth/hybridai-auth.js';
import { getConfigSnapshot, HYBRIDAI_BASE_URL } from '../config/config.js';
import { logger } from '../logger.js';
import {
  countQueuedFeedbackDrafts,
  expireFeedbackDrafts,
  type FeedbackDraftRecord,
  findQueuedFeedbackDraftByTitle,
  getFeedbackDraft,
  getRecentMessages,
  getSessionById,
  getStructuredAuditForSession,
  insertFeedbackDraft,
  listFeedbackDrafts,
  markFeedbackDraftViewed,
  updateFeedbackDraftStatus,
} from '../memory/db.js';
import { normalizeBaseUrl } from '../providers/utils.js';
import { redactSecrets } from '../security/redact.js';
import { formatAuditTurnTrace } from '../session/session-turn-trace.js';

export { REPORT_FEEDBACK_TOOL_NAME };

const HYBRIDAI_AGENT_FEEDBACK_TIMEOUT_MS = 15_000;
const HYBRIDAI_AGENT_FEEDBACK_URL = `${normalizeBaseUrl(
  HYBRIDAI_BASE_URL,
)}/api/agent_feedback`;

/** Newest-first transcript excerpt attached on `/feedback send --transcript`. */
const TRANSCRIPT_MESSAGE_LIMIT = 40;
const TRANSCRIPT_MESSAGE_MAX_CHARS = 2_000;
const TRANSCRIPT_BUDGET_BYTES = 64 * 1024;

export class FeedbackDraftsDisabledError extends Error {
  constructor() {
    super(
      'Feedback drafts are disabled. Enable `feedback.drafts.enabled` to let agents queue reports.',
    );
    this.name = 'FeedbackDraftsDisabledError';
  }
}

export class FeedbackDraftNotFoundError extends Error {
  constructor(id: string) {
    super(`Feedback draft \`${id}\` was not found.`);
    this.name = 'FeedbackDraftNotFoundError';
  }
}

export class FeedbackDraftInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedbackDraftInvalidError';
  }
}

export class FeedbackDraftSubmitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedbackDraftSubmitError';
  }
}

export function isFeedbackDraftsEnabled(): boolean {
  return getConfigSnapshot().feedback.drafts.enabled;
}

let cachedGatewayVersion: string | null = null;

function resolveGatewayVersion(): string {
  if (cachedGatewayVersion) return cachedGatewayVersion;
  const envVersion = String(process.env.npm_package_version || '').trim();
  if (envVersion) {
    cachedGatewayVersion = envVersion;
    return envVersion;
  }
  try {
    const packageJsonPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'package.json',
    );
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
      version?: unknown;
    };
    if (typeof parsed.version === 'string' && parsed.version.trim()) {
      cachedGatewayVersion = parsed.version.trim();
      return cachedGatewayVersion;
    }
  } catch {
    // Fall through to the unknown marker.
  }
  cachedGatewayVersion = '0.0.0';
  return cachedGatewayVersion;
}

function latestTurnRunId(sessionId: string): string | null {
  const rows = getStructuredAuditForSession(sessionId);
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.event_type === 'turn.start' && row.run_id) return row.run_id;
  }
  return null;
}

export interface CreateFeedbackDraftInput {
  sessionId: string;
  channelId?: string | null;
  agentId?: string | null;
  model?: string | null;
  provider?: string | null;
  draft: unknown;
}

export interface CreateFeedbackDraftResult {
  draft: FeedbackDraftRecord;
  deduplicated: boolean;
}

export function createFeedbackDraft(
  input: CreateFeedbackDraftInput,
): CreateFeedbackDraftResult {
  if (!isFeedbackDraftsEnabled()) throw new FeedbackDraftsDisabledError();

  const sessionId = input.sessionId.trim();
  if (!sessionId) throw new FeedbackDraftInvalidError('Missing `sessionId`.');
  const session = getSessionById(sessionId);
  if (!session) {
    throw new FeedbackDraftInvalidError(
      `Session \`${sessionId}\` was not found.`,
    );
  }

  const validated = validateFeedbackDraftInput(input.draft);
  if (!validated.ok) throw new FeedbackDraftInvalidError(validated.error);
  const draft = validated.value;

  const existing = findQueuedFeedbackDraftByTitle({
    sessionId: session.id,
    title: draft.title,
  });
  if (existing) return { draft: existing, deduplicated: true };

  if (
    countQueuedFeedbackDrafts(session.id) >=
    FEEDBACK_DRAFT_MAX_QUEUED_PER_SESSION
  ) {
    throw new FeedbackDraftInvalidError(
      `This session already has ${FEEDBACK_DRAFT_MAX_QUEUED_PER_SESSION} queued feedback drafts. Ask the operator to review them with /feedback before drafting more.`,
    );
  }

  const record = insertFeedbackDraft({
    sessionId: session.id,
    agentId: input.agentId?.trim() || session.agent_id || null,
    channelId: input.channelId?.trim() || session.channel_id || null,
    runId: latestTurnRunId(session.id),
    model: input.model?.trim() || session.model || null,
    provider: input.provider,
    gatewayVersion: resolveGatewayVersion(),
    trigger: draft.trigger,
    type: draft.type,
    title: redactSecrets(draft.title),
    details: redactSecrets(draft.details),
    area: draft.area ? redactSecrets(draft.area) : null,
    failureMode: draft.failure_mode ?? null,
    taskCategory: draft.task_category ?? null,
  });

  recordAuditEvent({
    sessionId: session.id,
    runId: record.run_id || makeAuditRunId('feedback'),
    event: {
      type: 'feedback.draft.created',
      draftId: record.id,
      draftType: record.type,
      trigger: record.trigger,
      title: record.title,
      area: record.area,
      failureMode: record.failure_mode,
      taskCategory: record.task_category,
      agentId: record.agent_id,
      model: record.model,
      createdAt: record.created_at,
    },
  });

  return { draft: record, deduplicated: false };
}

function requireDraft(id: string): FeedbackDraftRecord {
  const trimmed = id.trim();
  const draft = trimmed ? getFeedbackDraft(trimmed) : null;
  if (!draft) throw new FeedbackDraftNotFoundError(trimmed || id);
  return draft;
}

export function listSessionFeedbackDrafts(
  sessionId: string,
): FeedbackDraftRecord[] {
  expireFeedbackDrafts();
  return listFeedbackDrafts({ sessionId, status: 'queued' });
}

export function viewFeedbackDraft(id: string): FeedbackDraftRecord {
  requireDraft(id);
  const viewed = markFeedbackDraftViewed(id);
  if (!viewed) throw new FeedbackDraftNotFoundError(id);
  return viewed;
}

export function discardFeedbackDraft(input: {
  id: string;
  operatorUserId: string;
}): FeedbackDraftRecord {
  const draft = requireDraft(input.id);
  if (draft.status !== 'queued') {
    throw new FeedbackDraftInvalidError(
      `Feedback draft \`${draft.id}\` is already ${draft.status}.`,
    );
  }
  const updated = updateFeedbackDraftStatus({
    id: draft.id,
    status: 'discarded',
    submittedBy: input.operatorUserId,
  });
  if (!updated) throw new FeedbackDraftNotFoundError(draft.id);
  recordAuditEvent({
    sessionId: updated.session_id,
    runId: makeAuditRunId('feedback'),
    event: {
      type: 'feedback.draft.discarded',
      draftId: updated.id,
      operatorUserId: input.operatorUserId,
      discardedAt: updated.updated_at,
    },
  });
  return updated;
}

interface TranscriptExcerpt {
  messages: Array<{ role: string; content: string; createdAt: string }>;
  turnTrace: string | null;
  truncated: boolean;
}

function buildTranscriptExcerpt(draft: FeedbackDraftRecord): TranscriptExcerpt {
  const recent = getRecentMessages(draft.session_id, TRANSCRIPT_MESSAGE_LIMIT);
  const messages: TranscriptExcerpt['messages'] = [];
  let budget = TRANSCRIPT_BUDGET_BYTES;
  let truncated = false;
  // Newest kept first: walk backwards and stop once the budget is spent.
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const message = recent[index];
    if (!message) continue;
    let content = redactSecrets(String(message.content ?? ''));
    if (content.length > TRANSCRIPT_MESSAGE_MAX_CHARS) {
      content = `${content.slice(0, TRANSCRIPT_MESSAGE_MAX_CHARS)}…`;
      truncated = true;
    }
    const size = Buffer.byteLength(content, 'utf8') + 64;
    if (size > budget) {
      truncated = true;
      break;
    }
    budget -= size;
    messages.unshift({
      role: message.role,
      content,
      createdAt: message.created_at,
    });
  }

  let turnTrace: string | null = null;
  if (draft.run_id) {
    const formatted = formatAuditTurnTrace({
      sessionId: draft.session_id,
      auditEntries: getStructuredAuditForSession(draft.session_id),
      selector: { runId: draft.run_id },
    });
    if (!('error' in formatted)) turnTrace = redactSecrets(formatted.text);
  }

  return { messages, turnTrace, truncated };
}

export interface SubmitFeedbackDraftInput {
  id: string;
  operatorUserId: string;
  includeTranscript?: boolean;
  sourceSurface?: string;
}

export interface SubmitFeedbackDraftResult {
  draft: FeedbackDraftRecord;
  transcriptIncluded: boolean;
  transcriptTruncated: boolean;
}

export async function submitFeedbackDraft(
  input: SubmitFeedbackDraftInput,
): Promise<SubmitFeedbackDraftResult> {
  const draft = requireDraft(input.id);
  if (draft.status !== 'queued') {
    throw new FeedbackDraftInvalidError(
      `Feedback draft \`${draft.id}\` is already ${draft.status}.`,
    );
  }

  let apiKey = '';
  try {
    if (getHybridAIAuthStatus().authenticated) apiKey = getHybridAIApiKey();
  } catch {
    apiKey = '';
  }
  if (!apiKey) {
    throw new FeedbackDraftSubmitError(
      'Not signed in to HybridAI. Run `hybridclaw auth login` on the gateway before sending feedback.',
    );
  }

  const includeTranscript = input.includeTranscript === true;
  const transcript = includeTranscript ? buildTranscriptExcerpt(draft) : null;
  const sourceSurface = input.sourceSurface?.trim().toLowerCase() || 'web';

  const payload = {
    draft_id: draft.id,
    type: draft.type,
    title: draft.title,
    details: draft.details,
    area: draft.area,
    trigger: draft.trigger,
    failure_mode: draft.failure_mode,
    task_category: draft.task_category,
    created_at: draft.created_at,
    context: {
      session_id: draft.session_id,
      run_id: draft.run_id,
      agent_id: draft.agent_id,
      channel_id: draft.channel_id,
      model: draft.model,
      provider: draft.provider,
      gateway_version: draft.gateway_version,
    },
    review: {
      // Mirrors the "reviewed vs quick-approved" provenance so triage knows
      // whether a human read the draft before it left the deployment.
      viewed_before_send: Boolean(draft.viewed_at),
      submitted_via: sourceSurface,
      external_user_id: input.operatorUserId,
    },
    ...(transcript
      ? {
          transcript: {
            messages: transcript.messages,
            turn_trace: transcript.turnTrace,
            truncated: transcript.truncated,
          },
        }
      : {}),
  };

  let response: Response;
  try {
    response = await fetch(HYBRIDAI_AGENT_FEEDBACK_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(HYBRIDAI_AGENT_FEEDBACK_TIMEOUT_MS),
    });
  } catch (error) {
    logger.warn(
      { draftId: draft.id, error },
      'Feedback draft submission request failed',
    );
    throw new FeedbackDraftSubmitError(
      `Could not reach HybridAI: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    const body = (await response.text().catch(() => '')).trim();
    logger.warn(
      { draftId: draft.id, status: response.status, body: body.slice(0, 500) },
      'Feedback draft submission rejected',
    );
    throw new FeedbackDraftSubmitError(
      `HybridAI rejected the feedback (HTTP ${response.status})${body ? `: ${body.slice(0, 200)}` : ''}.`,
    );
  }

  const updated = updateFeedbackDraftStatus({
    id: draft.id,
    status: 'submitted',
    submittedBy: input.operatorUserId,
  });
  if (!updated) throw new FeedbackDraftNotFoundError(draft.id);

  recordAuditEvent({
    sessionId: updated.session_id,
    runId: makeAuditRunId('feedback'),
    event: {
      type: 'feedback.draft.submitted',
      draftId: updated.id,
      operatorUserId: input.operatorUserId,
      sourceSurface,
      transcriptIncluded: includeTranscript,
      viewedBeforeSend: Boolean(updated.viewed_at),
      submittedAt: updated.updated_at,
    },
  });

  return {
    draft: updated,
    transcriptIncluded: includeTranscript,
    transcriptTruncated: transcript?.truncated ?? false,
  };
}

const TYPE_LABEL: Record<FeedbackDraftRecord['type'], string> = {
  bug: 'bug',
  idea: 'idea',
  missing_capability: 'missing capability',
};

export function formatFeedbackDraftLine(draft: FeedbackDraftRecord): string {
  const age = draft.created_at.slice(0, 16).replace('T', ' ');
  return `\`${draft.id}\` [${TYPE_LABEL[draft.type]}] ${draft.title} · ${age} UTC`;
}

export function formatFeedbackDraftDetail(draft: FeedbackDraftRecord): string {
  const meta = [
    `Type: ${TYPE_LABEL[draft.type]}`,
    `Status: ${draft.status}`,
    `Trigger: ${draft.trigger}`,
    draft.area ? `Area: ${draft.area}` : null,
    draft.failure_mode ? `Failure mode: ${draft.failure_mode}` : null,
    draft.task_category ? `Task: ${draft.task_category}` : null,
    draft.model
      ? `Model: ${draft.model}${draft.provider ? ` (${draft.provider})` : ''}`
      : null,
    draft.run_id ? `Run: ${draft.run_id}` : null,
    `Created: ${draft.created_at}`,
    `Expires: ${draft.expires_at}`,
  ].filter((line): line is string => Boolean(line));
  return [
    `**${draft.title}**`,
    '',
    draft.details,
    '',
    ...meta,
    '',
    `Send with \`/feedback send ${draft.id}\` (add \`--transcript\` to attach the last ${TRANSCRIPT_MESSAGE_LIMIT} messages and the turn trace), or \`/feedback discard ${draft.id}\`. Nothing is sent without you.`,
  ].join('\n');
}
