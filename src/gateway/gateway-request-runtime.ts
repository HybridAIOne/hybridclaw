import { stopSessionExecution } from '../agent/executor.js';
import {
  getAgentGrant,
  isAgentGrantActive,
  subscribeAgentGrantChanges,
} from '../agents/agent-grants.js';

const GRANT_RECHECK_INTERVAL_MS = 1_000;
const GRANT_ACCESS_ENDED_MESSAGE = 'Agent access grant was revoked or expired.';

interface ActiveGatewayRequest {
  controller: AbortController;
  sessionId: string;
  executionSessionId: string;
  agentId?: string;
  principal?: string;
  detachExternalAbort?: () => void;
  grantRecheckTimer?: ReturnType<typeof setTimeout>;
}

const activeGatewayRequestsBySession = new Map<
  string,
  Set<ActiveGatewayRequest>
>();

function deleteGatewayRequestEntry(
  sessionId: string,
  entry: ActiveGatewayRequest,
): void {
  if (entry.grantRecheckTimer) {
    clearTimeout(entry.grantRecheckTimer);
    entry.grantRecheckTimer = undefined;
  }
  entry.detachExternalAbort?.();
  const sessionEntries = activeGatewayRequestsBySession.get(sessionId);
  if (!sessionEntries) return;
  sessionEntries.delete(entry);
  if (sessionEntries.size === 0) {
    activeGatewayRequestsBySession.delete(sessionId);
  }
}

function abortGatewayRequestForEndedGrant(entry: ActiveGatewayRequest): void {
  deleteGatewayRequestEntry(entry.sessionId, entry);
  if (!entry.controller.signal.aborted) {
    entry.controller.abort(new Error(GRANT_ACCESS_ENDED_MESSAGE));
  }
  stopSessionExecution(entry.executionSessionId);
}

function refreshGatewayRequestGrant(entry: ActiveGatewayRequest): void {
  if (!entry.agentId || !entry.principal || entry.controller.signal.aborted) {
    return;
  }
  if (entry.grantRecheckTimer) {
    clearTimeout(entry.grantRecheckTimer);
    entry.grantRecheckTimer = undefined;
  }

  let grant: ReturnType<typeof getAgentGrant>;
  try {
    grant = getAgentGrant(entry.agentId, entry.principal);
  } catch {
    abortGatewayRequestForEndedGrant(entry);
    return;
  }
  if (!grant || !isAgentGrantActive(grant)) {
    abortGatewayRequestForEndedGrant(entry);
    return;
  }
  const delayMs = grant.expires_at
    ? Math.max(
        1,
        Math.min(
          GRANT_RECHECK_INTERVAL_MS,
          Date.parse(grant.expires_at) - Date.now(),
        ),
      )
    : GRANT_RECHECK_INTERVAL_MS;
  entry.grantRecheckTimer = setTimeout(
    () => refreshGatewayRequestGrant(entry),
    delayMs,
  );
  entry.grantRecheckTimer.unref?.();
}

function refreshActiveGatewayRequestsForGrant(
  agentId: string,
  principal: string,
): void {
  for (const entries of activeGatewayRequestsBySession.values()) {
    for (const entry of [...entries]) {
      if (entry.agentId === agentId && entry.principal === principal) {
        refreshGatewayRequestGrant(entry);
      }
    }
  }
}

subscribeAgentGrantChanges(({ agentId, principal }) => {
  refreshActiveGatewayRequestsForGrant(agentId, principal);
});

export function registerActiveGatewayRequest(params: {
  sessionId: string;
  abortSignal?: AbortSignal;
  executionSessionId?: string;
  agentId?: string;
  principal?: string;
}): {
  signal: AbortSignal;
  release: () => void;
} {
  const controller = new AbortController();
  const entry: ActiveGatewayRequest = {
    controller,
    sessionId: params.sessionId,
    executionSessionId: params.executionSessionId || params.sessionId,
    agentId: params.agentId,
    principal: params.principal,
  };
  const externalSignal = params.abortSignal;
  if (externalSignal) {
    const onAbort = () => {
      controller.abort(externalSignal.reason);
    };
    externalSignal.addEventListener('abort', onAbort, { once: true });
    entry.detachExternalAbort = () => {
      externalSignal.removeEventListener('abort', onAbort);
    };
    if (externalSignal.aborted) onAbort();
  }

  let sessionEntries = activeGatewayRequestsBySession.get(params.sessionId);
  if (!sessionEntries) {
    sessionEntries = new Set();
    activeGatewayRequestsBySession.set(params.sessionId, sessionEntries);
  }
  sessionEntries.add(entry);
  refreshGatewayRequestGrant(entry);

  return {
    signal: controller.signal,
    release: () => {
      deleteGatewayRequestEntry(entry.sessionId, entry);
    },
  };
}

export function abortActiveGatewayRequests(sessionId: string): number {
  const sessionEntries = activeGatewayRequestsBySession.get(sessionId);
  if (!sessionEntries || sessionEntries.size === 0) return 0;
  const entries = [...sessionEntries];
  activeGatewayRequestsBySession.delete(sessionId);
  for (const entry of entries) {
    deleteGatewayRequestEntry(sessionId, entry);
    if (!entry.controller.signal.aborted) {
      entry.controller.abort(new Error('Interrupted by user.'));
    }
  }
  return entries.length;
}

export function interruptGatewaySessionExecution(sessionId: string): boolean {
  const sessionEntries = activeGatewayRequestsBySession.get(sessionId);
  const executionSessionIds = new Set(
    [...(sessionEntries || [])]
      .map((entry) => entry.executionSessionId)
      .filter((value) => typeof value === 'string' && value.trim().length > 0),
  );
  const abortedRequests = abortActiveGatewayRequests(sessionId);
  if (executionSessionIds.size === 0) {
    executionSessionIds.add(sessionId);
  }
  let stoppedExecutor = false;
  for (const executionSessionId of executionSessionIds) {
    stoppedExecutor =
      stopSessionExecution(executionSessionId) || stoppedExecutor;
  }
  return abortedRequests > 0 || stoppedExecutor;
}
