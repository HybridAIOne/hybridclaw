/**
 * Pending-approval store: the requests each session is waiting on, kept in one
 * workspace file that every session of the agent shares.
 *
 * Each record names its session (hashed), a runtime loads only its own
 * session's records, and a save replaces only those after re-reading the file
 * for the rest, so one session can neither answer nor overwrite another
 * session's requests. Two saves in the same instant can still lose one change.
 * NOT the gateway's prompt cache (src/gateway/pending-approvals.ts), which
 * tracks the prompt a channel shows.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface PendingApproval {
  id: string;
  // '' for requests saved before sessions were recorded: no session sees them.
  sessionHash: string;
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
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { pending?: unknown };
    return Array.isArray(parsed?.pending)
      ? parsed.pending
          .map((entry) => parsePersistedPendingApproval(entry))
          .filter((entry): entry is PendingApproval => Boolean(entry))
      : [];
  } catch {
    return [];
  }
}

export function saveSessionPendingApprovals(
  storePath: string,
  sessionHash: string,
  pending: Iterable<PendingApproval>,
): void {
  const now = Date.now();
  const otherSessions = readPendingApprovals(storePath).filter(
    (entry) => entry.sessionHash !== sessionHash && entry.expiresAtMs > now,
  );
  const payload: PersistedPendingApprovalStore = {
    version: 1,
    pending: [...otherSessions, ...pending].sort(
      (left, right) => left.createdAtMs - right.createdAtMs,
    ),
    updatedAt: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const tmpPath = `${storePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
    fs.renameSync(tmpPath, storePath);
  } catch {
    // ignore persistence failures and continue with in-memory pending approvals
  }
}

export function loadSessionPendingApprovals(
  storePath: string,
  sessionHash: string,
): PendingApproval[] {
  const now = Date.now();
  const stored = readPendingApprovals(storePath);
  const live = stored.filter((entry) => entry.expiresAtMs > now);
  const own = live.filter((entry) => entry.sessionHash === sessionHash);
  if (live.length < stored.length) {
    console.warn(
      `[approval-policy] dropped ${stored.length - live.length} expired persisted pending approval(s) on load`,
    );
    saveSessionPendingApprovals(storePath, sessionHash, own);
  }
  return own;
}
