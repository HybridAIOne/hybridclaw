/**
 * Active gateway requests own cancellation, deadlines, steering, progress and worker identity/roots.
 * A worker alias resolves only to its unique live conversation; this registry
 * does not create durable sessions or guess an owner after a request ends.
 */

import type { ExecutionDeadline } from '@hybridclaw/contracts/agent-io';
import {
  ExecutionDeadlineError,
  remainingExecutionMs,
  resolveExecutionDeadline,
} from '@hybridclaw/shared/execution-deadline';
import { stopSessionExecution } from '../agent/executor.js';
import type { WorkspaceOverrides } from '../agent/executor-types.js';
import type { SteerInbox } from '../infra/steer-inbox.js';
import type { ToolProgressEvent } from '../types/execution.js';

interface ActiveGatewayRequest extends ExecutionDeadline {
  controller: AbortController;
  executionSessionId: string;
  steerInbox?: SteerInbox;
  workspaceOverrides?: WorkspaceOverrides;
  onToolProgress?: (event: ToolProgressEvent) => void;
  detachExternalAbort?: () => void;
  clearDeadline?: () => void;
}

function watchExecutionDeadline(entry: ActiveGatewayRequest): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = () => {
    if (entry.controller.signal.aborted) return;
    const remaining = remainingExecutionMs(entry.executionDeadlineAtMs);
    if (remaining === undefined) return;
    if (remaining === 0) {
      entry.controller.abort(new ExecutionDeadlineError());
      return;
    }
    // Node timers overflow beyond signed 32-bit milliseconds; long bounds recheck.
    timer = setTimeout(check, Math.min(remaining, 2 ** 31 - 1));
    timer.unref();
  };
  check();
  return () => clearTimeout(timer);
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
  entry.clearDeadline?.();
  const sessionEntries = activeGatewayRequestsBySession.get(sessionId);
  if (!sessionEntries) return;
  sessionEntries.delete(entry);
  if (sessionEntries.size === 0) {
    activeGatewayRequestsBySession.delete(sessionId);
  }
}

export function registerActiveGatewayRequest(
  params: ExecutionDeadline & {
    sessionId: string;
    abortSignal?: AbortSignal;
    executionSessionId?: string;
    workspaceOverrides?: WorkspaceOverrides;
    steerInbox?: SteerInbox;
    onToolProgress?: (event: ToolProgressEvent) => void;
    maxWallClockMs?: number | null;
  },
): ExecutionDeadline & {
  signal: AbortSignal;
  release: () => void;
} {
  const controller = new AbortController();
  const entry: ActiveGatewayRequest = {
    controller,
    executionDeadlineAtMs: resolveExecutionDeadline(
      params.maxWallClockMs,
      params.executionDeadlineAtMs,
    ),
    executionSessionId: params.executionSessionId || params.sessionId,
    steerInbox: params.steerInbox,
    onToolProgress: params.onToolProgress
      ? (event) => {
          if (
            !controller.signal.aborted &&
            activeGatewayRequestsBySession.get(params.sessionId)?.has(entry)
          )
            params.onToolProgress?.(event);
        }
      : undefined,
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
  entry.clearDeadline = watchExecutionDeadline(entry);

  return {
    signal: controller.signal,
    executionDeadlineAtMs: entry.executionDeadlineAtMs,
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
    entry.clearDeadline?.();
    entry.controller.abort(new Error('Interrupted by user.'));
  }
  return entries.length;
}

export function resolveGatewayRequestContext(executionSessionId: string):
  | (ExecutionDeadline & {
      sessionId: string;
      workspaceOverrides?: WorkspaceOverrides;
      onToolProgress?: (event: ToolProgressEvent) => void;
    })
  | null {
  let owner:
    | (ExecutionDeadline & {
        sessionId: string;
        workspaceOverrides?: WorkspaceOverrides;
        onToolProgress?: (event: ToolProgressEvent) => void;
      })
    | null = null;
  let knownOwner = false;
  for (const [sessionId, entries] of activeGatewayRequestsBySession) {
    for (const entry of entries) {
      if (entry.executionSessionId !== executionSessionId) continue;
      knownOwner = true;
      if (entry.controller.signal.aborted) continue;
      if (
        owner &&
        (owner.sessionId !== sessionId ||
          owner.onToolProgress !== entry.onToolProgress ||
          owner.executionDeadlineAtMs !== entry.executionDeadlineAtMs ||
          owner.workspaceOverrides?.workspacePathOverride !==
            entry.workspaceOverrides?.workspacePathOverride ||
          owner.workspaceOverrides?.workspaceDisplayRootOverride !==
            entry.workspaceOverrides?.workspaceDisplayRootOverride)
      )
        return null;
      owner = {
        sessionId,
        workspaceOverrides: entry.workspaceOverrides,
        onToolProgress: entry.onToolProgress,
        executionDeadlineAtMs: entry.executionDeadlineAtMs,
      };
    }
  }
  return owner ?? (knownOwner ? null : { sessionId: executionSessionId });
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
