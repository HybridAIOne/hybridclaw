import { randomUUID } from 'node:crypto';
import { listAgents } from '../agents/agent-registry.js';
import {
  makeAuditRunId,
  type RecordAuditEventInput,
  recordAuditEvent,
} from '../audit/audit-events.js';
import {
  getRuntimeAssetRevisionState,
  listRuntimeAssetRevisionStates,
  syncRuntimeAssetRevisionState,
} from '../config/runtime-config-revisions.js';
import { enqueueProactiveMessage } from '../memory/db.js';
import {
  type EscalationTarget,
  escalationTargetEquals,
  normalizeEscalationTarget,
} from '../types/execution.js';
import { parseJsonObject } from '../utils/json-object.js';
import { isSupportedProactiveChannelId } from './proactive-delivery.js';

export const INTERACTION_SESSION_DEFAULT_TTL_MS = 30 * 60_000;
export const INTERACTION_SESSION_MIN_TTL_MS = 60_000;
export const INTERACTION_SESSION_MAX_PENDING = 500;

export const INTERACTION_MODALITIES = [
  'totp',
  'push',
  'qr',
  'sms',
  'recovery_code',
] as const;

export type InteractionModality = (typeof INTERACTION_MODALITIES)[number];

export type OperatorReturnKind =
  | 'code'
  | 'approved'
  | 'scanned'
  | 'declined'
  | 'timeout';

export type OperatorReturn =
  | { kind: 'code'; value: string }
  | { kind: 'approved' }
  | { kind: 'scanned' }
  | { kind: 'declined'; reason?: string }
  | { kind: 'timeout' };

export interface SuspendedFrameSnapshot {
  url: string;
  title?: string | null;
  browserSessionKey?: string | null;
  storageStateRef?: string | null;
  screenshotRef?: string | null;
}

export interface SuspendedSessionContext {
  host?: string | null;
  pageTitle?: string | null;
  url?: string | null;
  screenshotRef?: string | null;
}

export type SuspendedSessionStatus =
  | 'pending'
  | 'resumed'
  | 'declined'
  | 'timed_out'
  | 'expired';

export interface SuspendedSession {
  schemaVersion: 1;
  sessionId: string;
  approvalId: string;
  prompt: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  resolvedAt?: number | null;
  status: SuspendedSessionStatus;
  modality: InteractionModality;
  expectedReturnKinds: OperatorReturnKind[];
  frameSnapshot: SuspendedFrameSnapshot;
  context: SuspendedSessionContext;
  agentId?: string | null;
  skillId?: string | null;
  escalationTarget?: EscalationTarget;
  response?: StoredOperatorReturn | null;
}

export type StoredOperatorReturn =
  | { kind: 'code'; valueRedacted: true }
  | { kind: 'approved' }
  | { kind: 'scanned' }
  | { kind: 'declined'; reason?: string }
  | { kind: 'timeout' };

export interface CreateSuspendedSessionInput {
  sessionId?: string;
  approvalId?: string;
  prompt: string;
  userId: string;
  modality: InteractionModality;
  frameSnapshot: SuspendedFrameSnapshot;
  context?: SuspendedSessionContext;
  agentId?: string | null;
  skillId?: string | null;
  escalationTarget?: EscalationTarget;
  expectedReturnKinds?: OperatorReturnKind[];
  expiresAt?: number | null;
  ttlMs?: number | null;
}

export interface TwoFactorDetectionInput {
  url?: string | null;
  title?: string | null;
  text?: string | null;
  selectors?: string[];
}

export interface TwoFactorDetectionResult {
  detected: boolean;
  modality: InteractionModality | null;
  signals: string[];
}

export interface InteractionRoutingPlan {
  modality: InteractionModality;
  target?: EscalationTarget;
  preferredChannels: string[];
  fallbackChannels: string[];
}

export interface ResumeWithTextResult {
  session: SuspendedSession;
  response: OperatorReturn;
}

export function parseOperatorReturnText(
  text: string,
  expectedReturnKinds: OperatorReturnKind[] = [
    'code',
    'approved',
    'scanned',
    'declined',
    'timeout',
  ],
): OperatorReturn | null {
  const normalized = text.trim();
  if (!normalized) return null;
  const expected = new Set(expectedReturnKinds);
  const lower = normalized.toLowerCase();

  if (
    expected.has('declined') &&
    /^(decline|declined|deny|denied|no|cancel|stop)\b/.test(lower)
  ) {
    const reason = normalized.replace(/^[^:\s]+:?\s*/i, '').trim();
    return reason && reason !== normalized
      ? { kind: 'declined', reason }
      : { kind: 'declined' };
  }
  if (expected.has('timeout') && /^(timeout|timed out|expired)\b/.test(lower)) {
    return { kind: 'timeout' };
  }
  if (
    expected.has('approved') &&
    /^(approve|approved|yes|ok|confirm|confirmed)\b/.test(lower)
  ) {
    return { kind: 'approved' };
  }
  if (
    expected.has('scanned') &&
    /^(scan|scanned|qr scanned|done)\b/.test(lower)
  ) {
    return { kind: 'scanned' };
  }
  if (expected.has('code')) {
    const digits = normalized.replace(/[\s-]/g, '');
    if (/^\d{4,12}$/.test(digits)) {
      return { kind: 'code', value: digits };
    }
  }
  return null;
}

const SUSPENDED_SESSION_ASSET_PREFIX = 'interactive-escalation/session/';
const operatorReturnBySession = new Map<string, OperatorReturn>();
const PREFERRED_CHANNELS_BY_MODALITY: Record<InteractionModality, string[]> = {
  totp: ['mobile_admin', 'sms'],
  push: ['push', 'mobile_admin'],
  qr: ['mobile_admin', 'push'],
  sms: ['sms', 'mobile_admin'],
  recovery_code: ['mobile_admin', 'sms'],
};
const TWO_FACTOR_TEXT_PATTERNS: Array<{
  modality: InteractionModality;
  pattern: RegExp;
  signal: string;
}> = [
  {
    modality: 'totp',
    pattern: /\b(authenticator|totp)\b/i,
    signal: 'totp text',
  },
  {
    modality: 'push',
    pattern: /\b(push|approve.+device)\b/i,
    signal: 'push text',
  },
  { modality: 'qr', pattern: /\b(qr|scan.+code)\b/i, signal: 'qr text' },
  { modality: 'sms', pattern: /\b(sms|text message)\b/i, signal: 'sms text' },
  {
    modality: 'recovery_code',
    pattern: /\b(recovery code|backup code)\b/i,
    signal: 'recovery-code text',
  },
];

function suspendedSessionAssetPath(sessionId: string): string {
  const normalized = encodeURIComponent(sessionId.trim());
  return `${SUSPENDED_SESSION_ASSET_PREFIX}${normalized || 'session'}.json`;
}

function isInteractionModality(value: unknown): value is InteractionModality {
  return (
    typeof value === 'string' &&
    INTERACTION_MODALITIES.includes(value as InteractionModality)
  );
}

function isOperatorReturnKind(value: unknown): value is OperatorReturnKind {
  return (
    value === 'code' ||
    value === 'approved' ||
    value === 'scanned' ||
    value === 'declined' ||
    value === 'timeout'
  );
}

function normalizeExpectedReturnKinds(
  modality: InteractionModality,
  kinds?: OperatorReturnKind[],
): OperatorReturnKind[] {
  if (kinds?.length) {
    return [...new Set(kinds.filter(isOperatorReturnKind))];
  }
  if (modality === 'push') return ['approved', 'declined', 'timeout'];
  if (modality === 'qr') return ['scanned', 'declined', 'timeout'];
  return ['code', 'declined', 'timeout'];
}

function normalizeSuspendedSession(value: unknown): SuspendedSession | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const sessionId =
    typeof raw.sessionId === 'string' ? raw.sessionId.trim() : '';
  const approvalId =
    typeof raw.approvalId === 'string' ? raw.approvalId.trim() : '';
  const prompt = typeof raw.prompt === 'string' ? raw.prompt : '';
  const userId = typeof raw.userId === 'string' ? raw.userId.trim() : '';
  const createdAt = typeof raw.createdAt === 'number' ? raw.createdAt : NaN;
  const expiresAt = typeof raw.expiresAt === 'number' ? raw.expiresAt : NaN;
  const modality = isInteractionModality(raw.modality) ? raw.modality : null;
  const frameSnapshot =
    raw.frameSnapshot &&
    typeof raw.frameSnapshot === 'object' &&
    !Array.isArray(raw.frameSnapshot)
      ? (raw.frameSnapshot as Record<string, unknown>)
      : null;
  const frameUrl =
    typeof frameSnapshot?.url === 'string' ? frameSnapshot.url.trim() : '';

  if (
    !sessionId ||
    !approvalId ||
    !prompt ||
    !userId ||
    !Number.isFinite(createdAt) ||
    !Number.isFinite(expiresAt) ||
    !modality ||
    !frameUrl
  ) {
    return null;
  }

  const expectedReturnKinds = Array.isArray(raw.expectedReturnKinds)
    ? raw.expectedReturnKinds.filter(isOperatorReturnKind)
    : normalizeExpectedReturnKinds(modality);
  const status =
    raw.status === 'resumed' ||
    raw.status === 'declined' ||
    raw.status === 'timed_out' ||
    raw.status === 'expired'
      ? raw.status
      : 'pending';
  const context =
    raw.context &&
    typeof raw.context === 'object' &&
    !Array.isArray(raw.context)
      ? (raw.context as SuspendedSessionContext)
      : {};

  return {
    schemaVersion: 1,
    sessionId,
    approvalId,
    prompt,
    userId,
    createdAt,
    expiresAt,
    resolvedAt:
      typeof raw.resolvedAt === 'number' && Number.isFinite(raw.resolvedAt)
        ? raw.resolvedAt
        : null,
    status,
    modality,
    expectedReturnKinds,
    frameSnapshot: {
      url: frameUrl,
      title:
        typeof frameSnapshot?.title === 'string' ? frameSnapshot.title : null,
      browserSessionKey:
        typeof frameSnapshot?.browserSessionKey === 'string'
          ? frameSnapshot.browserSessionKey
          : null,
      storageStateRef:
        typeof frameSnapshot?.storageStateRef === 'string'
          ? frameSnapshot.storageStateRef
          : null,
      screenshotRef:
        typeof frameSnapshot?.screenshotRef === 'string'
          ? frameSnapshot.screenshotRef
          : null,
    },
    context,
    agentId: typeof raw.agentId === 'string' ? raw.agentId : null,
    skillId: typeof raw.skillId === 'string' ? raw.skillId : null,
    escalationTarget: normalizeEscalationTarget(raw.escalationTarget),
    response:
      raw.response && typeof raw.response === 'object'
        ? (raw.response as StoredOperatorReturn)
        : null,
  };
}

function persistSuspendedSession(session: SuspendedSession): void {
  syncRuntimeAssetRevisionState(
    'suspended_session',
    suspendedSessionAssetPath(session.sessionId),
    {
      route: 'interactive-escalation.session',
      source: 'gateway',
    },
    {
      exists: true,
      content: JSON.stringify(session),
    },
  );
}

function storedOperatorReturn(response: OperatorReturn): StoredOperatorReturn {
  if (response.kind === 'code') return { kind: 'code', valueRedacted: true };
  if (response.kind === 'declined') {
    const reason = String(response.reason || '').trim();
    return reason
      ? { kind: 'declined', reason: reason.slice(0, 500) }
      : { kind: 'declined' };
  }
  return response;
}

function statusForResponse(response: OperatorReturn): SuspendedSessionStatus {
  if (response.kind === 'declined') return 'declined';
  if (response.kind === 'timeout') return 'timed_out';
  return 'resumed';
}

function assertSuspendedSessionCapacity(nextSessionId: string): void {
  const existing = getSuspendedSession(nextSessionId);
  if (existing?.status === 'pending') return;
  const pendingCount = listSuspendedSessions().length;
  if (pendingCount >= INTERACTION_SESSION_MAX_PENDING) {
    throw new Error(
      `Too many pending suspended sessions (${pendingCount}); refusing to create another interactive escalation.`,
    );
  }
}

function timeoutEscalationMessage(session: SuspendedSession): string {
  const host =
    session.context.host || session.context.url || 'the current page';
  return [
    `Timeout escalation: ${session.modality} handover for ${host} did not receive an operator response.`,
    session.prompt,
    `Session: ${session.sessionId}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function resolveTimeoutEscalationTarget(
  session: SuspendedSession,
): EscalationTarget | null {
  const agentId = String(session.agentId || '').trim();
  if (!agentId) return null;
  try {
    const agents = listAgents();
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    const agent = byId.get(agentId);
    const managerId = String(agent?.reportsTo || '').trim();
    const managerTarget = managerId
      ? normalizeEscalationTarget(byId.get(managerId)?.escalationTarget)
      : null;
    if (
      managerTarget &&
      !escalationTargetEquals(managerTarget, session.escalationTarget)
    ) {
      return managerTarget;
    }
  } catch {
    return null;
  }
  return null;
}

function queueTimeoutEscalation(session: SuspendedSession): {
  result: 'not_configured' | 'blocked' | 'queued' | 'failed';
  target?: EscalationTarget;
  reason?: string;
  queued?: number;
  dropped?: number;
} {
  const target = resolveTimeoutEscalationTarget(session);
  if (!target) return { result: 'not_configured' };
  if (!isSupportedProactiveChannelId(target.channel)) {
    return {
      result: 'blocked',
      target,
      reason: 'unsupported_proactive_target',
    };
  }
  try {
    const queued = enqueueProactiveMessage(
      target.channel,
      timeoutEscalationMessage(session),
      'interactive-escalation:timeout',
      100,
    );
    return { result: 'queued', target, ...queued };
  } catch (error) {
    return {
      result: 'failed',
      target,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function expireSuspendedSession(session: SuspendedSession, now: number): void {
  session.status = 'expired';
  session.resolvedAt = now;
  session.response = { kind: 'timeout' };
  persistSuspendedSession(session);
  const timeoutEscalation = queueTimeoutEscalation(session);
  recordAuditEvent({
    sessionId: session.sessionId,
    runId: makeAuditRunId('interaction-timeout'),
    event: {
      type: 'escalation.timeout',
      approvalId: session.approvalId,
      agentId: session.agentId || null,
      skillId: session.skillId || null,
      modality: session.modality,
      context: session.context,
      escalationTarget: session.escalationTarget || null,
      timeoutEscalation,
    },
  });
}

export function getSuspendedSession(
  sessionId: string,
): SuspendedSession | null {
  const state = getRuntimeAssetRevisionState(
    'suspended_session',
    suspendedSessionAssetPath(sessionId),
  );
  if (!state) return null;
  return normalizeSuspendedSession(parseJsonObject(state.content));
}

export function listSuspendedSessions(options?: {
  includeResolved?: boolean;
}): SuspendedSession[] {
  const now = Date.now();
  const sessions = listRuntimeAssetRevisionStates('suspended_session')
    .filter((state) =>
      state.assetPath.startsWith(SUSPENDED_SESSION_ASSET_PREFIX),
    )
    .map((state) => normalizeSuspendedSession(parseJsonObject(state.content)))
    .filter((session): session is SuspendedSession => Boolean(session));

  for (const session of sessions) {
    if (session.status === 'pending' && session.expiresAt <= now) {
      expireSuspendedSession(session, now);
    }
  }

  return sessions
    .filter(
      (session) => options?.includeResolved || session.status === 'pending',
    )
    .sort((left, right) => right.createdAt - left.createdAt);
}

export function createSuspendedSession(
  input: CreateSuspendedSessionInput,
): SuspendedSession {
  const createdAt = Date.now();
  const sessionId = input.sessionId?.trim() || randomUUID();
  assertSuspendedSessionCapacity(sessionId);
  const expiresAt =
    typeof input.expiresAt === 'number' && Number.isFinite(input.expiresAt)
      ? Math.max(createdAt + INTERACTION_SESSION_MIN_TTL_MS, input.expiresAt)
      : createdAt +
        Math.max(
          INTERACTION_SESSION_MIN_TTL_MS,
          input.ttlMs || INTERACTION_SESSION_DEFAULT_TTL_MS,
        );
  const session: SuspendedSession = {
    schemaVersion: 1,
    sessionId,
    approvalId: input.approvalId?.trim() || randomUUID(),
    prompt: input.prompt,
    userId: input.userId,
    createdAt,
    expiresAt,
    resolvedAt: null,
    status: 'pending',
    modality: input.modality,
    expectedReturnKinds: normalizeExpectedReturnKinds(
      input.modality,
      input.expectedReturnKinds,
    ),
    frameSnapshot: input.frameSnapshot,
    context: input.context || {},
    agentId: input.agentId || null,
    skillId: input.skillId || null,
    ...(input.escalationTarget
      ? { escalationTarget: input.escalationTarget }
      : {}),
    response: null,
  };
  persistSuspendedSession(session);
  return session;
}

export function awaitTwoFactor(
  input: Omit<CreateSuspendedSessionInput, 'modality'> & {
    modality?: InteractionModality;
  },
): SuspendedSession {
  return createSuspendedSession({
    ...input,
    modality: input.modality || 'totp',
  });
}

export function resumeWith(
  sessionId: string,
  response: OperatorReturn,
): SuspendedSession {
  const session = getSuspendedSession(sessionId);
  if (!session) {
    throw new Error(`Suspended session not found: ${sessionId}`);
  }
  if (session.status !== 'pending') {
    throw new Error(`Suspended session is already ${session.status}.`);
  }
  const now = Date.now();
  if (session.expiresAt <= now) {
    expireSuspendedSession(session, now);
    throw new Error('Suspended session has expired.');
  }
  if (!session.expectedReturnKinds.includes(response.kind)) {
    throw new Error(
      `Suspended session ${sessionId} does not accept ${response.kind} responses.`,
    );
  }

  session.status = statusForResponse(response);
  session.resolvedAt = now;
  session.response = storedOperatorReturn(response);
  operatorReturnBySession.set(session.sessionId, response);
  persistSuspendedSession(session);
  recordAuditEvent({
    sessionId: session.sessionId,
    runId: makeAuditRunId('interaction-response'),
    event: {
      type: 'escalation.interaction_response',
      approvalId: session.approvalId,
      responseKind: response.kind,
      status: session.status,
      codeRedacted: response.kind === 'code',
    },
  });
  return session;
}

export function consumeOperatorReturn(
  sessionId: string,
): OperatorReturn | null {
  const normalized = sessionId.trim();
  if (!normalized) return null;
  const response = operatorReturnBySession.get(normalized) || null;
  if (response) {
    operatorReturnBySession.delete(normalized);
  }
  return response;
}

export function resumeWithText(
  sessionId: string,
  text: string,
): ResumeWithTextResult {
  const session = getSuspendedSession(sessionId);
  if (!session) {
    throw new Error(`Suspended session not found: ${sessionId}`);
  }
  const response = parseOperatorReturnText(text, session.expectedReturnKinds);
  if (!response) {
    throw new Error(
      `Could not parse operator response for suspended session ${sessionId}.`,
    );
  }
  return {
    response,
    session: resumeWith(sessionId, response),
  };
}

export function findPendingSuspendedSessionForOperator(params: {
  userId?: string | null;
  modality?: InteractionModality | null;
}): SuspendedSession | null {
  const normalizedUserId = String(params.userId || '').trim();
  const sessions = listSuspendedSessions();
  return (
    sessions.find((session) => {
      if (params.modality && session.modality !== params.modality) {
        return false;
      }
      if (!normalizedUserId) return true;
      return (
        session.userId === normalizedUserId ||
        session.escalationTarget?.recipient === normalizedUserId
      );
    }) || null
  );
}

export function detectTwoFactorChallenge(
  input: TwoFactorDetectionInput,
): TwoFactorDetectionResult {
  const signals: string[] = [];
  const selectors = input.selectors || [];
  for (const selector of selectors) {
    const normalized = selector.toLowerCase();
    if (
      normalized.includes('autocomplete="one-time-code"') ||
      normalized.includes("autocomplete='one-time-code'") ||
      normalized.includes('input[autocomplete=one-time-code]') ||
      normalized.includes('input[type=tel]') ||
      normalized.includes('inputmode=numeric') ||
      normalized.includes('name*="otp"') ||
      normalized.includes("name*='otp'") ||
      normalized.includes('id*="otp"') ||
      normalized.includes("id*='otp'") ||
      normalized.includes('name*="code"') ||
      normalized.includes("name*='code'") ||
      normalized.includes('id*="code"') ||
      normalized.includes("id*='code'")
    ) {
      signals.push(`selector:${selector}`);
    }
  }

  const text = [input.title, input.text].filter(Boolean).join('\n');
  for (const entry of TWO_FACTOR_TEXT_PATTERNS) {
    if (entry.pattern.test(text)) {
      signals.push(entry.signal);
      return {
        detected: true,
        modality: entry.modality,
        signals,
      };
    }
  }

  if (
    /\b(verification code|one[- ]time code|two[- ]factor|2fa|multi[- ]factor)\b/i.test(
      text,
    )
  ) {
    signals.push('generic 2fa text');
  }

  return {
    detected: signals.length > 0,
    modality: signals.length > 0 ? 'totp' : null,
    signals,
  };
}

export function resolveInteractionRouting(
  modality: InteractionModality,
  target?: EscalationTarget,
): InteractionRoutingPlan {
  const preferredChannels = PREFERRED_CHANNELS_BY_MODALITY[modality];
  const fallbackChannels = [
    ...preferredChannels,
    ...['sms', 'email'].filter(
      (channel) => !preferredChannels.includes(channel),
    ),
  ];
  return {
    modality,
    ...(target ? { target } : {}),
    preferredChannels,
    fallbackChannels,
  };
}

export function formatInteractionRequest(session: SuspendedSession): string {
  const host =
    session.context.host || session.context.url || 'the current page';
  const expected = session.expectedReturnKinds.join(' / ');
  return [
    `Interaction needed: ${session.modality} for ${host}.`,
    session.prompt,
    `Session: ${session.sessionId}`,
    `Reply with: ${expected}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function emitInteractionNeededEvent(input: {
  session: SuspendedSession;
  runId?: string;
  parentRunId?: string;
  recordAudit?: (event: RecordAuditEventInput) => void;
}): void {
  const record = input.recordAudit || recordAuditEvent;
  record({
    sessionId: input.session.sessionId,
    runId: input.runId || makeAuditRunId('interaction'),
    ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
    event: {
      type: 'escalation.interaction_needed',
      approvalId: input.session.approvalId,
      agentId: input.session.agentId || null,
      skillId: input.session.skillId || null,
      modality: input.session.modality,
      expectedReturnKinds: input.session.expectedReturnKinds,
      context: input.session.context,
      frameSnapshot: input.session.frameSnapshot,
      urgency: 'interactive',
      routing: resolveInteractionRouting(
        input.session.modality,
        input.session.escalationTarget,
      ),
    },
  });
}
