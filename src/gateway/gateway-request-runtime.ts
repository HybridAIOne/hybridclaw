import { stopSessionExecution } from '../agent/executor.js';
import { enqueueSteeringNote } from '../infra/ipc.js';

interface ActiveGatewayRequest {
  controller: AbortController;
  executionSessionId: string;
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

function listExecutionSessionIds(sessionId: string): string[] {
  const sessionEntries = activeGatewayRequestsBySession.get(sessionId);
  if (!sessionEntries || sessionEntries.size === 0) return [];
  return [
    ...new Set(
      [...sessionEntries]
        .map((entry) => entry.executionSessionId)
        .filter(
          (value) => typeof value === 'string' && value.trim().length > 0,
        ),
    ),
  ];
}

export function registerActiveGatewayRequest(params: {
  sessionId: string;
  abortSignal?: AbortSignal;
  executionSessionId?: string;
}): {
  signal: AbortSignal;
  release: () => void;
} {
  const controller = new AbortController();
  const entry: ActiveGatewayRequest = {
    controller,
    executionSessionId: params.executionSessionId || params.sessionId,
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

export function enqueueGatewaySessionSteeringNote(params: {
  sessionId: string;
  note: string;
}): {
  queued: number;
  executionSessionIds: string[];
} {
  const executionSessionIds = listExecutionSessionIds(params.sessionId);
  for (const executionSessionId of executionSessionIds) {
    enqueueSteeringNote(executionSessionId, params.note);
  }
  return {
    queued: executionSessionIds.length,
    executionSessionIds,
  };
}

export function interruptGatewaySessionExecution(sessionId: string): boolean {
  const executionSessionIds = new Set(listExecutionSessionIds(sessionId));
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
