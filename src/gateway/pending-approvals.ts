export interface PendingApprovalPrompt {
  approvalId: string;
  prompt: string;
  createdAt: number;
  expiresAt: number;
  userId: string;
  resolvedAt?: number | null;
  disableButtons?: (() => Promise<void>) | null;
  disableTimeout?: ReturnType<typeof setTimeout> | null;
}

const pendingApprovalBySession = new Map<string, PendingApprovalPrompt>();

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
  return pendingApprovalBySession.get(sessionId) || null;
}

export async function setPendingApproval(
  sessionId: string,
  entry: PendingApprovalPrompt,
): Promise<void> {
  const existing = pendingApprovalBySession.get(sessionId) || null;
  if (existing) {
    pendingApprovalBySession.delete(sessionId);
    await disposePendingApprovalEntry(existing, { disableButtons: true });
  }
  pendingApprovalBySession.set(sessionId, entry);
}

export async function clearPendingApproval(
  sessionId: string,
  options?: { disableButtons?: boolean },
): Promise<PendingApprovalPrompt | null> {
  const existing = pendingApprovalBySession.get(sessionId) || null;
  if (!existing) return null;
  pendingApprovalBySession.delete(sessionId);
  await disposePendingApprovalEntry(existing, options);
  return existing;
}

export async function cleanupExpiredPendingApprovals(): Promise<void> {
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
  const normalizedApprovalId = approvalId.trim();
  if (!normalizedApprovalId) return null;
  const now = Date.now();
  for (const [sessionId, entry] of pendingApprovalBySession.entries()) {
    if (entry.expiresAt <= now) {
      pendingApprovalBySession.delete(sessionId);
      void disposePendingApprovalEntry(entry, { disableButtons: true });
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
  const normalizedApprovalId = params.approvalId.trim();
  if (!normalizedApprovalId) return { status: 'not_found' };
  const now = Date.now();
  for (const [sessionId, entry] of pendingApprovalBySession.entries()) {
    if (entry.expiresAt <= now) {
      pendingApprovalBySession.delete(sessionId);
      void disposePendingApprovalEntry(entry, { disableButtons: true });
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
    return { status: 'claimed', sessionId, entry };
  }
  return { status: 'not_found' };
}
