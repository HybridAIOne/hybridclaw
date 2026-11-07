/**
 * One workspace pending file preserves every session's executable requests.
 * Cross-process locks cover reads, merges, expiry pruning and atomic writes;
 * failed persistence throws before the policy can grant replay or trust.
 * NOT the gateway prompt lifecycle: completed worker decisions leave this store.
 */
import fs from 'node:fs';
import { writeFileAtomic } from '#shared/atomic-write.js';
import { waitForMemoryFileLockSync } from '#shared/memory-file.js';

export interface PendingApproval {
  id: string;
  // '' for requests saved before sessions were recorded: no session sees them.
  sessionHash: string;
  userHash?: string;
  fingerprint: string;
  actionKey: string;
  toolName: string;
  argsJson: string;
  intent: string;
  consequenceIfDenied: string;
  reason: string;
  commandPreview: string;
  createdAtMs: number;
  expiresAtMs: number;
  originalPrompt: string;
  pinned: boolean;
}

interface PersistedPendingApprovalStore {
  version: 1;
  pending: PendingApproval[];
  updatedAt: string;
}

function parsePersistedPendingApproval(value: unknown): PendingApproval | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const fingerprint =
    typeof record.fingerprint === 'string' ? record.fingerprint.trim() : '';
  const actionKey =
    typeof record.actionKey === 'string' ? record.actionKey.trim() : '';
  const toolName =
    typeof record.toolName === 'string' ? record.toolName.trim() : '';
  const argsJson = typeof record.argsJson === 'string' ? record.argsJson : '';
  const intent = typeof record.intent === 'string' ? record.intent.trim() : '';
  const consequenceIfDenied =
    typeof record.consequenceIfDenied === 'string'
      ? record.consequenceIfDenied.trim()
      : '';
  const reason = typeof record.reason === 'string' ? record.reason.trim() : '';
  const commandPreview =
    typeof record.commandPreview === 'string'
      ? record.commandPreview.trim()
      : '';
  const originalPrompt =
    typeof record.originalPrompt === 'string' ? record.originalPrompt : '';
  const createdAtMs =
    typeof record.createdAtMs === 'number' ? record.createdAtMs : NaN;
  const expiresAtMs =
    typeof record.expiresAtMs === 'number' ? record.expiresAtMs : NaN;

  if (
    !id ||
    !fingerprint ||
    !actionKey ||
    !toolName ||
    !intent ||
    !consequenceIfDenied ||
    !reason ||
    !Number.isFinite(createdAtMs) ||
    !Number.isFinite(expiresAtMs)
  ) {
    return null;
  }

  return {
    id,
    ...(typeof record.userHash === 'string'
      ? { userHash: record.userHash }
      : {}),
    sessionHash:
      typeof record.sessionHash === 'string' ? record.sessionHash : '',
    fingerprint,
    actionKey,
    toolName,
    argsJson,
    intent,
    consequenceIfDenied,
    reason,
    commandPreview,
    createdAtMs,
    expiresAtMs,
    originalPrompt,
    pinned: record.pinned === true,
  };
}

function readPendingApprovals(storePath: string): PendingApproval[] {
  let raw: string;
  try {
    raw = fs.readFileSync(storePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  let parsed: PersistedPendingApprovalStore;
  try {
    parsed = JSON.parse(raw) as PersistedPendingApprovalStore;
  } catch {
    throw new Error('Invalid pending approval store');
  }
  if (parsed?.version !== 1 || !Array.isArray(parsed.pending)) {
    throw new Error('Invalid pending approval store');
  }
  return parsed.pending.map((entry) => {
    const pending = parsePersistedPendingApproval(entry);
    if (!pending) throw new Error('Invalid pending approval record');
    return pending;
  });
}

function writePendingApprovals(
  storePath: string,
  pending: PendingApproval[],
): void {
  const payload: PersistedPendingApprovalStore = {
    version: 1,
    pending: pending.sort(
      (left, right) => left.createdAtMs - right.createdAtMs,
    ),
    updatedAt: new Date().toISOString(),
  };
  writeFileAtomic(storePath, JSON.stringify(payload, null, 2));
}

export function saveSessionPendingApprovals(
  storePath: string,
  sessionHash: string,
  pending: Iterable<PendingApproval>,
): void {
  const release = waitForMemoryFileLockSync(storePath);
  try {
    const now = Date.now();
    const own = [...pending];
    if (own.some((entry) => entry.sessionHash !== sessionHash))
      throw new Error('Pending approval session mismatch');
    const otherSessions = readPendingApprovals(storePath).filter(
      (entry) => entry.sessionHash !== sessionHash && entry.expiresAtMs > now,
    );
    writePendingApprovals(storePath, [...otherSessions, ...own]);
  } finally {
    release();
  }
}

export function loadSessionPendingApprovals(
  storePath: string,
  sessionHash: string,
): PendingApproval[] {
  const release = waitForMemoryFileLockSync(storePath);
  try {
    const now = Date.now();
    const stored = readPendingApprovals(storePath);
    const live = stored.filter((entry) => entry.expiresAtMs > now);
    if (live.length < stored.length) {
      writePendingApprovals(storePath, live);
      console.warn(
        `[approval-policy] dropped ${stored.length - live.length} expired persisted pending approval(s) on load`,
      );
    }
    return live.filter((entry) => entry.sessionHash === sessionHash);
  } finally {
    release();
  }
}
