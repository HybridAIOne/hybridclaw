type CommandApprovalMode = 'once' | 'session';

const oneShotTrustedActionsBySession = new Map<string, Set<string>>();
const sessionTrustedActionsBySession = new Map<string, Set<string>>();

function getOrCreateActionSet(
  store: Map<string, Set<string>>,
  sessionId: string,
): Set<string> {
  const existing = store.get(sessionId);
  if (existing) return existing;
  const created = new Set<string>();
  store.set(sessionId, created);
  return created;
}

export function recordCommandApproval(params: {
  sessionId: string;
  actionKey: string;
  mode: CommandApprovalMode;
}): void {
  const sessionId = String(params.sessionId || '').trim();
  const actionKey = String(params.actionKey || '').trim();
  if (!sessionId || !actionKey) return;
  const targetStore =
    params.mode === 'session'
      ? sessionTrustedActionsBySession
      : oneShotTrustedActionsBySession;
  getOrCreateActionSet(targetStore, sessionId).add(actionKey);
}

export function consumeCommandApproval(params: {
  sessionId: string;
  actionKey: string;
}): boolean {
  const sessionId = String(params.sessionId || '').trim();
  const actionKey = String(params.actionKey || '').trim();
  if (!sessionId || !actionKey) return false;

  const oneShot = oneShotTrustedActionsBySession.get(sessionId);
  if (oneShot?.delete(actionKey)) {
    if (oneShot.size === 0) {
      oneShotTrustedActionsBySession.delete(sessionId);
    }
    return true;
  }

  return sessionTrustedActionsBySession.get(sessionId)?.has(actionKey) === true;
}

export function clearCommandApprovalsForSession(sessionId: string): void {
  const normalized = String(sessionId || '').trim();
  if (!normalized) return;
  oneShotTrustedActionsBySession.delete(normalized);
  sessionTrustedActionsBySession.delete(normalized);
}
