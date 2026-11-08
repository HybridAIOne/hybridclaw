/**
 * A watchdog may interrupt only the full-auto run that armed it, once.
 * Recovery policy stays in fullauto; this observes progress and requests a stop.
 */
import {
  FULLAUTO_STALL_POLL_MS,
  FULLAUTO_STALL_TIMEOUT_MS,
} from '../config/config.js';
import { logger } from '../logger.js';
import {
  type FullAutoRuntimeState,
  isCurrentFullAutoRuntimeState,
} from './fullauto-runtime.js';
import { interruptGatewaySessionExecution } from './gateway-request-runtime.js';

export function startFullAutoWatchdog(params: {
  sessionId: string;
  state: FullAutoRuntimeState;
  runToken: number;
}): void {
  if (FULLAUTO_STALL_TIMEOUT_MS <= 0) return;
  const pollMs = Math.max(1_000, FULLAUTO_STALL_POLL_MS);
  params.state.lifecycle.watch(params.runToken, pollMs, () => {
    if (!isCurrentFullAutoRuntimeState(params.sessionId, params.state)) return;
    const lastProgressAt =
      params.state.lastProgressAt ?? params.state.lastTurnStartedAt;
    if (!lastProgressAt) return;
    const idleMs = Date.now() - lastProgressAt;
    if (idleMs < FULLAUTO_STALL_TIMEOUT_MS) return;

    if (!params.state.lifecycle.interrupt(params.runToken)) return;
    params.state.consecutiveStalls += 1;
    params.state.lastInterventionAt = Date.now();
    logger.warn(
      {
        sessionId: params.sessionId,
        runToken: params.runToken,
        idleMs,
        lastProgressLabel: params.state.lastProgressLabel,
        consecutiveStalls: params.state.consecutiveStalls,
      },
      'Full-auto watchdog interrupting stalled turn',
    );
    interruptGatewaySessionExecution(params.sessionId);
  });
}
