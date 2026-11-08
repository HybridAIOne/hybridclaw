/**
 * Active gateway requests own cancellation, steering and worker identity/roots.
 * A worker alias resolves only to its unique live conversation; this registry
 * does not create durable sessions or guess an owner after a request ends.
 */

import { stopSessionExecution } from '../agent/executor.js';
import type { WorkspaceOverrides } from '../agent/executor-types.js';
import type { SteerInbox } from '../infra/steer-inbox.js';

interface ActiveGatewayRequest {
  controller: AbortController;
  executionSessionId: string;
  steerInbox?: SteerInbox;
  workspaceOverrides?: WorkspaceOverrides;
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
  workspaceOverrides?: WorkspaceOverrides;
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
    workspaceOverrides: {
      workspacePathOverride: params.workspaceOverrides?.workspacePathOverride,
      workspaceDisplayRootOverride:
        params.workspaceOverrides?.workspaceDisplayRootOverride,
    },
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

export function resolveGatewayRequestContext(executionSessionId: string): {
  sessionId: string;
  workspaceOverrides?: WorkspaceOverrides;
} | null {
  let owner: {
    sessionId: string;
    workspaceOverrides?: WorkspaceOverrides;
  } | null = null;
  for (const [sessionId, entries] of activeGatewayRequestsBySession) {
    for (const entry of entries) {
      if (
        entry.executionSessionId !== executionSessionId ||
        entry.controller.signal.aborted
      )
        continue;
      if (
        owner &&
        (owner.sessionId !== sessionId ||
          owner.workspaceOverrides?.workspacePathOverride !==
            entry.workspaceOverrides?.workspacePathOverride ||
          owner.workspaceOverrides?.workspaceDisplayRootOverride !==
            entry.workspaceOverrides?.workspaceDisplayRootOverride)
      )
        return null;
      owner = { sessionId, workspaceOverrides: entry.workspaceOverrides };
    }
  }
  return owner ?? { sessionId: executionSessionId };
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
