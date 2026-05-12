import { logger } from '../../logger.js';

export interface SignalTypingController {
  start: () => void;
  stop: () => void;
}

interface CreateSignalTypingControllerOptions {
  keepaliveMs?: number;
  ttlMs?: number;
}

const DEFAULT_KEEPALIVE_MS = 8_000;
const DEFAULT_TTL_MS = 60_000;

export function createSignalTypingController(
  sendTyping: (stop?: boolean) => Promise<boolean | undefined>,
  options?: CreateSignalTypingControllerOptions,
): SignalTypingController {
  const keepaliveMs = Math.max(
    2_000,
    Math.floor(options?.keepaliveMs ?? DEFAULT_KEEPALIVE_MS),
  );
  const ttlMs = Math.max(5_000, Math.floor(options?.ttlMs ?? DEFAULT_TTL_MS));

  let active = false;
  let stopped = false;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let ttlTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimers = (): void => {
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    if (ttlTimer) {
      clearTimeout(ttlTimer);
      ttlTimer = null;
    }
  };

  const stopNow = (): void => {
    active = false;
    clearTimers();
  };

  const emitTyping = async (stop?: boolean): Promise<void> => {
    try {
      await sendTyping(stop);
    } catch (error) {
      logger.debug({ error }, 'Signal typing indicator failed');
      if (!stopped) stopNow();
    }
  };

  return {
    start: () => {
      if (stopped || active) return;
      active = true;
      void emitTyping(false);
      keepaliveTimer = setInterval(() => {
        if (!active || stopped) return;
        void emitTyping(false);
      }, keepaliveMs);
      ttlTimer = setTimeout(() => {
        if (!active || stopped) return;
        stopNow();
      }, ttlMs);
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      const wasActive = active;
      stopNow();
      if (wasActive) {
        void emitTyping(true).catch(() => undefined);
      }
    },
  };
}
