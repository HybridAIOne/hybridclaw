/**
 * Gateway prompts move from pending to claimed to handed_off, or terminate
 * as expired/superseded. Every mutation checks the prompt and claim identity.
 * Handoff means accepted for processing; executable facts and consent scope
 * remain worker-owned. Button cleanup never controls durable state.
 */
import { randomUUID } from 'node:crypto';
import {
  listRuntimeAssetRevisionStates,
  syncRuntimeAssetRevisionState,
} from '../config/runtime-config-revisions.js';
import type { PendingApproval } from '../types/execution.js';
import { parseJsonObject } from '../utils/json-object.js';
import {
  type ApprovalPresentation,
  createApprovalPresentation,
} from './approval-presentation.js';

const APPROVAL_PROMPT_DEFAULT_TTL_MS = 120_000;
const APPROVAL_PROMPT_STATES = [
  'pending',
  'claimed',
  'handed_off',
  'expired',
  'superseded',
] as const;
const PENDING_APPROVAL_ASSET_PREFIX = 'pending-approvals/session/';

export interface PendingApprovalCommandAction {
  approveArgs: string[];
  actionKey?: string;
  allowSession?: boolean;
  allowAgent?: boolean;
  allowAll?: boolean;
  denyTitle?: string;
  denyText?: string;
}

export interface PendingApprovalClaim {
  sessionId: string;
  approvalId: string;
  claimId: string;
}

export interface PendingApprovalPrompt {
  approvalId: string;
  prompt: string;
  presentation?: ApprovalPresentation | null;
  /** Complete allowlisted facts shown by structured chat clients. */
  approval?: PendingApproval;
  createdAt: number;
  expiresAt: number;
  userId: string;
  state: (typeof APPROVAL_PROMPT_STATES)[number];
  claimId: string;
  commandAction?: PendingApprovalCommandAction | null;
  disableButtons?: (() => Promise<void>) | null;
  disableTimeout?: ReturnType<typeof setTimeout> | null;
}

const pendingApprovalBySession = new Map<string, PendingApprovalPrompt>();
let pendingApprovalsHydrated = false;

type DurablePendingApprovalPrompt = Omit<
  PendingApprovalPrompt,
  'disableButtons' | 'disableTimeout'
>;

function pendingApprovalAssetPath(sessionId: string): string {
  const normalized = encodeURIComponent(sessionId.trim());
  return `${PENDING_APPROVAL_ASSET_PREFIX}${normalized || 'session'}.json`;
}

function normalizeDurablePendingApproval(
  value: unknown,
): DurablePendingApprovalPrompt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const approvalId =
    typeof raw.approvalId === 'string' ? raw.approvalId.trim() : '';
  const prompt = typeof raw.prompt === 'string' ? raw.prompt : '';
  const createdAt = typeof raw.createdAt === 'number' ? raw.createdAt : NaN;
  const expiresAt = typeof raw.expiresAt === 'number' ? raw.expiresAt : NaN;
  const userId = typeof raw.userId === 'string' ? raw.userId.trim() : '';
  if (
    !(APPROVAL_PROMPT_STATES as readonly string[]).includes(
      String(raw.state),
    ) ||
    typeof raw.claimId !== 'string' ||
    !raw.claimId ||
    !approvalId ||
    !prompt ||
    !userId ||
    !Number.isFinite(createdAt) ||
    !Number.isFinite(expiresAt)
  ) {
    return null;
  }

  return {
    approvalId,
    prompt,
    presentation:
      raw.presentation &&
      typeof raw.presentation === 'object' &&
      !Array.isArray(raw.presentation)
        ? (raw.presentation as ApprovalPresentation)
        : createApprovalPresentation('text'),
    approval:
      raw.approval &&
      typeof raw.approval === 'object' &&
      !Array.isArray(raw.approval) &&
      (raw.approval as PendingApproval).approvalId === approvalId
        ? (raw.approval as PendingApproval)
        : undefined,
    createdAt,
    expiresAt,
    userId,
    state: raw.state as PendingApprovalPrompt['state'],
    claimId: raw.claimId,
    commandAction:
      raw.commandAction &&
      typeof raw.commandAction === 'object' &&
      !Array.isArray(raw.commandAction)
        ? (raw.commandAction as PendingApprovalCommandAction)
        : null,
  };
}

function serializePendingApproval(
  entry: PendingApprovalPrompt,
): DurablePendingApprovalPrompt {
  return {
    approvalId: entry.approvalId,
    prompt: entry.prompt,
    approval: entry.approval,
    presentation: entry.presentation ?? createApprovalPresentation('text'),
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
    userId: entry.userId,
    state: entry.state,
    claimId: entry.claimId,
    commandAction: entry.commandAction ?? null,
  };
}

function persistPendingApproval(
  sessionId: string,
  entry: PendingApprovalPrompt,
): void {
  syncRuntimeAssetRevisionState(
    'pending_approval',
    pendingApprovalAssetPath(sessionId),
    {
      route: 'pending-approvals.persist',
      source: 'gateway',
    },
    {
      exists: true,
      content: JSON.stringify(serializePendingApproval(entry)),
    },
  );
}

function rehydrateDurablePendingApprovals(): void {
  if (pendingApprovalsHydrated) return;
  const states = listRuntimeAssetRevisionStates('pending_approval').filter(
    (state) => state.assetPath.startsWith(PENDING_APPROVAL_ASSET_PREFIX),
  );
  for (const state of states) {
    const sessionId = decodeURIComponent(
      state.assetPath
        .slice(PENDING_APPROVAL_ASSET_PREFIX.length)
        .replace(/\.json$/, ''),
    );
    const durable = normalizeDurablePendingApproval(
      parseJsonObject(state.content),
    );
    if (!durable) continue;

    const existing = pendingApprovalBySession.get(sessionId);
    pendingApprovalBySession.set(sessionId, {
      ...durable,
      disableButtons: existing?.disableButtons ?? null,
      disableTimeout: existing?.disableTimeout ?? null,
    });
  }
  pendingApprovalsHydrated = true;
}

export function getStoredPendingApproval(
  sessionId: string,
): PendingApprovalPrompt | null {
  rehydrateDurablePendingApprovals();
  return pendingApprovalBySession.get(sessionId) || null;
}

function matchesClaim(
  entry: PendingApprovalPrompt,
  claim: PendingApprovalClaim,
): boolean {
  return (
    entry.approvalId === claim.approvalId && entry.claimId === claim.claimId
  );
}

function transitionPendingApproval(
  claim: PendingApprovalClaim,
  state: PendingApprovalPrompt['state'],
): PendingApprovalPrompt | null {
  const entry = getStoredPendingApproval(claim.sessionId);
  if (
    !entry ||
    !matchesClaim(entry, claim) ||
    (entry.state !== 'pending' && entry.state !== 'claimed')
  )
    return null;
  const next = { ...entry, state };
  persistPendingApproval(claim.sessionId, next);
  pendingApprovalBySession.set(claim.sessionId, next);
  return next;
}

function scheduleExpiry(sessionId: string, entry: PendingApprovalPrompt): void {
  if (entry.disableTimeout) clearTimeout(entry.disableTimeout);
  const identity = {
    sessionId,
    approvalId: entry.approvalId,
    claimId: entry.claimId,
  };
  entry.disableTimeout = setTimeout(
    () => expirePendingApproval(identity),
    Math.max(0, entry.expiresAt - Date.now()),
  );
}

function expirePendingApproval(claim: PendingApprovalClaim): void {
  const entry = getStoredPendingApproval(claim.sessionId);
  if (!entry || !matchesClaim(entry, claim) || entry.expiresAt > Date.now())
    return;
  if (entry.state !== 'pending' && entry.state !== 'claimed') return;
  const expired = transitionPendingApproval(claim, 'expired');
  if (expired)
    void disposePendingApprovalEntry(expired, { disableButtons: true });
}

async function disposePendingApprovalEntry(
  entry: PendingApprovalPrompt,
  options?: { disableButtons?: boolean },
): Promise<void> {
  if (entry.disableTimeout) {
    clearTimeout(entry.disableTimeout);
    entry.disableTimeout = null;
  }
  const disableButtons = entry.disableButtons;
  entry.disableButtons = null;
  if (options?.disableButtons && disableButtons) {
    await disableButtons().catch(() => {});
  }
}

export function getPendingApproval(
  sessionId: string,
): PendingApprovalPrompt | null {
  const entry = getStoredPendingApproval(sessionId);
  return entry && (entry.state === 'pending' || entry.state === 'claimed')
    ? entry
    : null;
}

export function listPendingApprovals(): Array<{
  sessionId: string;
  entry: PendingApprovalPrompt;
}> {
  rehydrateDurablePendingApprovals();
  const now = Date.now();
  const entries: Array<{
    sessionId: string;
    entry: PendingApprovalPrompt;
  }> = [];

  for (const [sessionId, entry] of pendingApprovalBySession.entries()) {
    if (entry.expiresAt <= now) {
      expirePendingApproval({ sessionId, ...entry });
      continue;
    }
    if (entry.state !== 'pending') {
      continue;
    }
    entries.push({ sessionId, entry });
  }

  entries.sort((left, right) => right.entry.createdAt - left.entry.createdAt);
  return entries;
}

function installPendingApproval(
  sessionId: string,
  entry: Omit<PendingApprovalPrompt, 'state' | 'claimId'>,
): { current: PendingApprovalPrompt; previous: PendingApprovalPrompt | null } {
  rehydrateDurablePendingApprovals();
  const nextEntry: PendingApprovalPrompt = {
    ...entry,
    state: 'pending',
    claimId: randomUUID(),
    presentation: entry.presentation ?? createApprovalPresentation('text'),
  };
  const existing = pendingApprovalBySession.get(sessionId) || null;
  persistPendingApproval(sessionId, nextEntry);
  pendingApprovalBySession.set(sessionId, nextEntry);
  if (
    existing &&
    (existing.state === 'pending' || existing.state === 'claimed')
  )
    existing.state = 'superseded';
  return { current: nextEntry, previous: existing };
}

export async function setPendingApproval(
  sessionId: string,
  entry: Omit<PendingApprovalPrompt, 'state' | 'claimId'>,
): Promise<void> {
  const { previous } = installPendingApproval(sessionId, entry);
  if (previous)
    await disposePendingApprovalEntry(previous, { disableButtons: true });
}

export async function rememberPendingApproval(params: {
  sessionId: string;
  approvalId: string;
  prompt: string;
  userId: string;
  expiresAt?: number | null;
  presentation?: ApprovalPresentation;
  approval?: PendingApproval;
  commandAction?: PendingApprovalCommandAction | null;
  disableButtons?: (() => Promise<void>) | null;
}): Promise<void> {
  const createdAt = Date.now();
  const expiresAt =
    typeof params.expiresAt === 'number' && Number.isFinite(params.expiresAt)
      ? Math.max(createdAt + 15_000, params.expiresAt)
      : createdAt + APPROVAL_PROMPT_DEFAULT_TTL_MS;
  const entry = {
    approvalId: params.approvalId,
    prompt: params.prompt,
    approval: params.approval,
    presentation: params.presentation ?? createApprovalPresentation('text'),
    createdAt,
    expiresAt,
    userId: params.userId,
    commandAction: params.commandAction ?? null,
    disableButtons: params.disableButtons ?? null,
    disableTimeout: null as ReturnType<typeof setTimeout> | null,
  };
  // Install the timer on the captured entry before yielding to old button cleanup.
  const { current, previous } = installPendingApproval(params.sessionId, entry);
  scheduleExpiry(params.sessionId, current);
  if (previous)
    await disposePendingApprovalEntry(previous, { disableButtons: true });
}

export async function clearPendingApproval(
  sessionId: string,
  expected: Pick<PendingApprovalClaim, 'approvalId' | 'claimId'> & {
    disableButtons?: boolean;
  },
): Promise<PendingApprovalPrompt | null> {
  const entry = transitionPendingApproval(
    { sessionId, ...expected },
    'superseded',
  );
  if (entry) await disposePendingApprovalEntry(entry, expected);
  return entry;
}

export async function cleanupExpiredPendingApprovals(): Promise<void> {
  rehydrateDurablePendingApprovals();
  for (const [sessionId, entry] of pendingApprovalBySession) {
    expirePendingApproval({ sessionId, ...entry });
  }
}

export function findPendingApprovalByApprovalId(approvalId: string): {
  sessionId: string;
  entry: PendingApprovalPrompt;
} | null {
  rehydrateDurablePendingApprovals();
  const normalizedApprovalId = approvalId.trim();
  if (!normalizedApprovalId) return null;
  const now = Date.now();
  for (const [sessionId, entry] of pendingApprovalBySession.entries()) {
    if (entry.expiresAt <= now) {
      expirePendingApproval({ sessionId, ...entry });
      continue;
    }
    if (entry.state !== 'pending') {
      continue;
    }
    if (entry.approvalId === normalizedApprovalId) {
      return { sessionId, entry };
    }
  }
  return null;
}

export function claimPendingApprovalByApprovalId(params: {
  approvalId: string;
  userId: string;
  sessionId?: string;
}):
  | {
      status: 'claimed';
      sessionId: string;
      entry: PendingApprovalPrompt;
      claim: PendingApprovalClaim;
    }
  | {
      status: 'unauthorized';
      sessionId: string;
      entry: PendingApprovalPrompt;
    }
  | {
      status: 'already_handled';
      sessionId: string;
      entry: PendingApprovalPrompt;
    }
  | { status: 'not_found' } {
  rehydrateDurablePendingApprovals();
  const normalizedApprovalId = params.approvalId.trim();
  if (!normalizedApprovalId) return { status: 'not_found' };
  const now = Date.now();
  for (const [sessionId, entry] of pendingApprovalBySession.entries()) {
    if (entry.expiresAt <= now) {
      expirePendingApproval({ sessionId, ...entry });
      continue;
    }
    if (
      (params.sessionId && params.sessionId !== sessionId) ||
      entry.approvalId !== normalizedApprovalId
    ) {
      continue;
    }
    if (entry.userId !== params.userId) {
      return { status: 'unauthorized', sessionId, entry };
    }
    if (entry.state !== 'pending') {
      return { status: 'already_handled', sessionId, entry };
    }
    const claimed: PendingApprovalPrompt = {
      ...entry,
      state: 'claimed',
      claimId: randomUUID(),
    };
    persistPendingApproval(sessionId, claimed);
    pendingApprovalBySession.set(sessionId, claimed);
    if (claimed.disableTimeout) scheduleExpiry(sessionId, claimed);
    return {
      status: 'claimed',
      sessionId,
      entry: claimed,
      claim: {
        sessionId,
        approvalId: claimed.approvalId,
        claimId: claimed.claimId,
      },
    };
  }
  return { status: 'not_found' };
}

export function rollbackPendingApprovalClaim(
  claim: PendingApprovalClaim,
): boolean {
  const entry = getStoredPendingApproval(claim.sessionId);
  if (!entry || !matchesClaim(entry, claim) || entry.state !== 'claimed')
    return false;
  if (entry.expiresAt <= Date.now()) {
    expirePendingApproval(claim);
    return false;
  }
  const pending: PendingApprovalPrompt = {
    ...entry,
    state: 'pending',
    claimId: randomUUID(),
  };
  persistPendingApproval(claim.sessionId, pending);
  pendingApprovalBySession.set(claim.sessionId, pending);
  if (pending.disableTimeout) scheduleExpiry(claim.sessionId, pending);
  return true;
}

export function handoffPendingApprovalClaim(
  claim: PendingApprovalClaim,
): boolean {
  const entry = getStoredPendingApproval(claim.sessionId);
  if (!entry || !matchesClaim(entry, claim) || entry.state !== 'claimed')
    return false;
  if (entry.expiresAt <= Date.now()) {
    expirePendingApproval(claim);
    return false;
  }
  const handedOff = transitionPendingApproval(claim, 'handed_off');
  if (handedOff)
    void disposePendingApprovalEntry(handedOff, { disableButtons: true });
  return Boolean(handedOff);
}

export function isPendingApprovalClaim(claim: PendingApprovalClaim): boolean {
  const entry = getStoredPendingApproval(claim.sessionId);
  return Boolean(
    entry &&
      matchesClaim(entry, claim) &&
      entry.state === 'claimed' &&
      entry.expiresAt > Date.now(),
  );
}
