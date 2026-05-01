import {
  listRuntimeAssetRevisionStates,
  syncRuntimeAssetRevisionState,
} from '../config/runtime-config-revisions.js';
import { parseJsonObject } from '../utils/json-object.js';
import {
  type ApprovalPresentation,
  createApprovalPresentation,
} from './approval-presentation.js';

const APPROVAL_PROMPT_DEFAULT_TTL_MS = 120_000;
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

export interface PendingApprovalPrompt {
  approvalId: string;
  prompt: string;
  presentation?: ApprovalPresentation | null;
  createdAt: number;
  expiresAt: number;
  userId: string;
  resolvedAt?: number | null;
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
    createdAt,
    expiresAt,
    userId,
    resolvedAt:
      typeof raw.resolvedAt === 'number' && Number.isFinite(raw.resolvedAt)
        ? raw.resolvedAt
        : null,
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
    presentation: entry.presentation ?? createApprovalPresentation('text'),
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
    userId: entry.userId,
    resolvedAt: entry.resolvedAt ?? null,
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

function deletePersistedPendingApproval(sessionId: string): void {
  syncRuntimeAssetRevisionState(
    'pending_approval',
    pendingApprovalAssetPath(sessionId),
    {
      route: 'pending-approvals.clear',
      source: 'gateway',
    },
    { exists: false, content: null },
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

function getStoredPendingApproval(
  sessionId: string,
): PendingApprovalPrompt | null {
  rehydrateDurablePendingApprovals();
  return pendingApprovalBySession.get(sessionId) || null;
}

function dropPendingApprovalEntry(
  sessionId: string,
  options?: { disableButtons?: boolean },
): PendingApprovalPrompt | null {
  const existing = pendingApprovalBySession.get(sessionId) || null;
  pendingApprovalBySession.delete(sessionId);
  deletePersistedPendingApproval(sessionId);
  if (existing) {
    void disposePendingApprovalEntry(existing, options);
  }
  return existing;
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
  return getStoredPendingApproval(sessionId);
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
      dropPendingApprovalEntry(sessionId, { disableButtons: true });
      continue;
    }
    if (entry.resolvedAt) {
      continue;
    }
    entries.push({ sessionId, entry });
  }

  entries.sort((left, right) => right.entry.createdAt - left.entry.createdAt);
  return entries;
}

export async function setPendingApproval(
  sessionId: string,
  entry: PendingApprovalPrompt,
): Promise<void> {
  const nextEntry: PendingApprovalPrompt = {
    ...entry,
    presentation: entry.presentation ?? createApprovalPresentation('text'),
  };
  const existing = pendingApprovalBySession.get(sessionId) || null;
  if (existing) {
    pendingApprovalBySession.delete(sessionId);
    deletePersistedPendingApproval(sessionId);
    await disposePendingApprovalEntry(existing, { disableButtons: true });
  }
  pendingApprovalBySession.set(sessionId, nextEntry);
  persistPendingApproval(sessionId, nextEntry);
}

export async function rememberPendingApproval(params: {
  sessionId: string;
  approvalId: string;
  prompt: string;
  userId: string;
  expiresAt?: number | null;
  presentation?: ApprovalPresentation;
  commandAction?: PendingApprovalCommandAction | null;
  disableButtons?: (() => Promise<void>) | null;
}): Promise<void> {
  const createdAt = Date.now();
  const expiresAt =
    typeof params.expiresAt === 'number' && Number.isFinite(params.expiresAt)
      ? Math.max(createdAt + 15_000, params.expiresAt)
      : createdAt + APPROVAL_PROMPT_DEFAULT_TTL_MS;
  const entry: PendingApprovalPrompt = {
    approvalId: params.approvalId,
    prompt: params.prompt,
    presentation: params.presentation ?? createApprovalPresentation('text'),
    createdAt,
    expiresAt,
    userId: params.userId,
    resolvedAt: null,
    commandAction: params.commandAction ?? null,
    disableButtons: params.disableButtons ?? null,
    disableTimeout: null,
  };
  entry.disableTimeout = setTimeout(
    () => {
      void clearPendingApproval(params.sessionId, { disableButtons: true });
    },
    Math.max(0, expiresAt - Date.now()),
  );
  await setPendingApproval(params.sessionId, entry);
}

export async function clearPendingApproval(
  sessionId: string,
  options?: { disableButtons?: boolean },
): Promise<PendingApprovalPrompt | null> {
  const existing = getStoredPendingApproval(sessionId);
  if (!existing) return null;
  pendingApprovalBySession.delete(sessionId);
  deletePersistedPendingApproval(sessionId);
  await disposePendingApprovalEntry(existing, options);
  return existing;
}

export async function cleanupExpiredPendingApprovals(): Promise<void> {
  rehydrateDurablePendingApprovals();
  const now = Date.now();
  const expiredSessionIds = [...pendingApprovalBySession.entries()]
    .filter(([, pending]) => pending.expiresAt <= now)
    .map(([sessionId]) => sessionId);
  await Promise.all(
    expiredSessionIds.map((sessionId) =>
      clearPendingApproval(sessionId, { disableButtons: true }),
    ),
  );
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
      dropPendingApprovalEntry(sessionId, { disableButtons: true });
      continue;
    }
    if (entry.resolvedAt) {
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
}):
  | {
      status: 'claimed';
      sessionId: string;
      entry: PendingApprovalPrompt;
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
      dropPendingApprovalEntry(sessionId, { disableButtons: true });
      continue;
    }
    if (entry.approvalId !== normalizedApprovalId) {
      continue;
    }
    if (entry.userId !== params.userId) {
      return { status: 'unauthorized', sessionId, entry };
    }
    if (entry.resolvedAt) {
      return { status: 'already_handled', sessionId, entry };
    }
    entry.resolvedAt = now;
    persistPendingApproval(sessionId, entry);
    return { status: 'claimed', sessionId, entry };
  }
  return { status: 'not_found' };
}

export function rollbackPendingApprovalClaim(params: {
  sessionId: string;
  approvalId: string;
}): boolean {
  const sessionId = params.sessionId.trim();
  const approvalId = params.approvalId.trim();
  if (!sessionId || !approvalId) {
    return false;
  }

  const entry = getStoredPendingApproval(sessionId);
  if (!entry) {
    return false;
  }
  if (entry.approvalId !== approvalId || !entry.resolvedAt) {
    return false;
  }

  entry.resolvedAt = null;
  persistPendingApproval(sessionId, entry);
  return true;
}
