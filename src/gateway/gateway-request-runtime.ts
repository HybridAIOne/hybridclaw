/**
 * Active gateway requests own cancellation, steering and worker identity.
 * A worker alias resolves only to its unique live conversation; this registry
 * does not create durable sessions or guess an owner after a request ends.
 */
import { stopSessionExecution } from '../agent/executor.js';
import type { SteerInbox } from '../infra/steer-inbox.js';

interface ActiveGatewayRequest {
  controller: AbortController;
  executionSessionId: string;
  steerInbox?: SteerInbox;
  detachExternalAbort?: () => void;
}

const activeGatewayRequestsBySession = new Map<
  string,
  Set<ActiveGatewayRequest>
>();

function deleteGatewayRequestEntry(
  sessionId: string,
  entry: ActiveGatewayRequest,
): void {
  entry.detachExternalAbort?.();
  const sessionEntries = activeGatewayRequestsBySession.get(sessionId);
  if (!sessionEntries) return;
  sessionEntries.delete(entry);
  if (sessionEntries.size === 0) {
    activeGatewayRequestsBySession.delete(sessionId);
  }
}

export function registerActiveGatewayRequest(params: {
  sessionId: string;
  abortSignal?: AbortSignal;
  executionSessionId?: string;
  steerInbox?: SteerInbox;
}): {
  signal: AbortSignal;
  release: () => void;
} {
  const controller = new AbortController();
  const entry: ActiveGatewayRequest = {
    controller,
    executionSessionId: params.executionSessionId || params.sessionId,
    steerInbox: params.steerInbox,
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

  return {
    signal: controller.signal,
    release: () => {
      deleteGatewayRequestEntry(params.sessionId, entry);
    },
  };
}

export function abortActiveGatewayRequests(sessionId: string): number {
  const sessionEntries = activeGatewayRequestsBySession.get(sessionId);
  if (!sessionEntries || sessionEntries.size === 0) return 0;
  const entries = [...sessionEntries];
  activeGatewayRequestsBySession.delete(sessionId);
  for (const entry of entries) {
    entry.detachExternalAbort?.();
    entry.controller.abort(new Error('Interrupted by user.'));
  }
  return entries.length;
}

export function resolveGatewayRequestSessionId(
  executionSessionId: string,
): string | null {
  let owner: string | null = null;
  for (const [sessionId, entries] of activeGatewayRequestsBySession) {
    if (
      ![...entries].some(
        (entry) =>
          entry.executionSessionId === executionSessionId &&
          !entry.controller.signal.aborted,
      )
    )
      continue;
    if (owner !== null && owner !== sessionId) return null;
    owner = sessionId;
  }
  return owner ?? executionSessionId;
}

/**
 * Hands `content` to the turn running in the session. True only when its
 * agent will show it to the model; a stopped turn is no longer registered.
 */
export function steerGatewaySession(
  sessionId: string,
  content: string,
): boolean {
  for (const entry of activeGatewayRequestsBySession.get(sessionId) ?? []) {
    if (entry.controller.signal.aborted) continue;
    if (entry.steerInbox?.deliver(content)) return true;
  }
  return false;
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
