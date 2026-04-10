import { logger } from '../../logger.js';

export interface TelegramTypingController {
  start: () => void;
  stop: () => void;
}

interface CreateTelegramTypingControllerOptions {
  keepaliveMs?: number;
  ttlMs?: number;
}

const DEFAULT_KEEPALIVE_MS = 4_000;
const DEFAULT_TTL_MS = 60_000;

export function createTelegramTypingController(
  sendTyping: () => Promise<boolean | undefined>,
  options?: CreateTelegramTypingControllerOptions,
): TelegramTypingController {
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

  const emitTyping = async (): Promise<void> => {
    try {
      await sendTyping();
    } catch (error) {
      logger.debug({ error }, 'Telegram typing indicator failed');
      if (!stopped) {
        stopNow();
      }
    }
  };

  const stopNow = (): void => {
    active = false;
    clearTimers();
  };

  return {
    start: () => {
      if (stopped || active) return;
      active = true;
      void emitTyping();
      keepaliveTimer = setInterval(() => {
        if (!active || stopped) return;
        void emitTyping();
      }, keepaliveMs);
      ttlTimer = setTimeout(() => {
        if (!active || stopped) return;
        stopNow();
      }, ttlMs);
    },
    stop: () => {
      if (stopped) return;
      stopNow();
      stopped = true;
    },
  };
}
