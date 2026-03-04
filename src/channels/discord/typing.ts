import type { Message as DiscordMessage } from 'discord.js';

import { logger } from '../../logger.js';

export type DiscordTypingPhase =
  | 'received'
  | 'thinking'
  | 'toolUse'
  | 'streaming'
  | 'done';
export type DiscordTypingMode = 'instant' | 'thinking' | 'streaming' | 'never';

export interface TypingController {
  setPhase: (phase: DiscordTypingPhase) => void;
  stop: () => void;
}

interface CreateTypingControllerOptions {
  keepaliveMs?: number;
  ttlMs?: number;
  stopGraceMs?: number;
}

const DEFAULT_KEEPALIVE_MS = 8_000;
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_STOP_GRACE_MS = 500;

function isTypingActiveForPhase(
  mode: DiscordTypingMode,
  phase: DiscordTypingPhase,
): boolean {
  if (mode === 'never') return false;
  if (mode === 'instant') return phase !== 'done';
  if (mode === 'thinking') return phase === 'thinking' || phase === 'toolUse';
  return phase === 'streaming';
}

export function createTypingController(
  message: DiscordMessage,
  mode: DiscordTypingMode,
  options?: CreateTypingControllerOptions,
): TypingController {
  if (mode === 'never') {
    return {
      setPhase: () => {},
      stop: () => {},
    };
  }

  const keepaliveMs = Math.max(
    2_000,
    Math.floor(options?.keepaliveMs ?? DEFAULT_KEEPALIVE_MS),
  );
  const ttlMs = Math.max(5_000, Math.floor(options?.ttlMs ?? DEFAULT_TTL_MS));
  const stopGraceMs = Math.max(
    0,
    Math.floor(options?.stopGraceMs ?? DEFAULT_STOP_GRACE_MS),
  );

  let active = false;
  let stopped = false;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let ttlTimer: ReturnType<typeof setTimeout> | null = null;
  let stopTimer: ReturnType<typeof setTimeout> | null = null;

  const sendTyping = async (): Promise<void> => {
    if (stopped || !active) return;
    if (!('sendTyping' in message.channel)) return;
    try {
      await message.channel.sendTyping();
    } catch (error) {
      logger.debug(
        { error, channelId: message.channelId },
        'Failed to send typing indicator',
      );
    }
  };

  const clearTimers = (): void => {
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    if (ttlTimer) {
      clearTimeout(ttlTimer);
      ttlTimer = null;
    }
    if (stopTimer) {
      clearTimeout(stopTimer);
      stopTimer = null;
    }
  };

  const stopNow = (): void => {
    active = false;
    clearTimers();
  };

  const scheduleStop = (): void => {
    if (stopped || !active) return;
    if (stopTimer) return;
    stopTimer = setTimeout(() => {
      stopTimer = null;
      stopNow();
    }, stopGraceMs);
  };

  const ensureRunning = (): void => {
    if (stopped) return;
    if (stopTimer) {
      clearTimeout(stopTimer);
      stopTimer = null;
    }
    if (active) return;
    active = true;
    void sendTyping();
    keepaliveTimer = setInterval(() => {
      void sendTyping();
    }, keepaliveMs);
    ttlTimer = setTimeout(() => {
      stopNow();
    }, ttlMs);
  };

  return {
    setPhase: (phase) => {
      if (stopped) return;
      if (isTypingActiveForPhase(mode, phase)) {
        ensureRunning();
      } else {
        scheduleStop();
      }
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      stopNow();
    },
  };
}
