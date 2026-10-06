/**
 * Discord typing indicator for one inbound batch.
 *
 * A bot message clears the bot's typing indicator in clients, but a typing
 * request that lands after that message shows it again for ~10s. Callers
 * await `settled()` before posting a reply so the last typing request is
 * finished first. Discord has no call that clears typing directly.
 */
import type { Message as DiscordMessage } from 'discord.js';

import { logDiscordApiError } from './transport-errors.js';

export type DiscordTypingPhase =
  | 'received'
  | 'thinking'
  | 'toolUse'
  | 'streaming'
  | 'done';
export type DiscordTypingMode = 'instant' | 'thinking' | 'streaming' | 'never';
export type LifecyclePhase = Exclude<DiscordTypingPhase, 'received'> | 'error';

export interface TypingController {
  setPhase: (phase: DiscordTypingPhase) => void;
  settled: () => Promise<void>;
  stop: () => void;
}

interface CreateTypingControllerOptions {
  keepaliveMs?: number;
  ttlMs?: number;
}

const DEFAULT_KEEPALIVE_MS = 8_000;
const DEFAULT_TTL_MS = 60_000;

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
      settled: async () => {},
      stop: () => {},
    };
  }

  const keepaliveMs = Math.max(
    2_000,
    Math.floor(options?.keepaliveMs ?? DEFAULT_KEEPALIVE_MS),
  );
  const ttlMs = Math.max(5_000, Math.floor(options?.ttlMs ?? DEFAULT_TTL_MS));

  let active = false;
  let stopped = false;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let ttlTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> = Promise.resolve();

  const sendTyping = (): void => {
    if (stopped || !active) return;
    if (!('sendTyping' in message.channel)) return;
    const request = message.channel.sendTyping().catch((error: unknown) => {
      logDiscordApiError({
        error,
        expectedAction: 'Typing indicator was not sent.',
        unexpectedMessage: 'Failed to send typing indicator',
        metadata: { channelId: message.channelId },
        level: 'debug',
      });
    });
    inFlight = inFlight.then(() => request);
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
  };

  const stopNow = (): void => {
    active = false;
    clearTimers();
  };

  const ensureRunning = (): void => {
    if (stopped || active) return;
    active = true;
    sendTyping();
    keepaliveTimer = setInterval(sendTyping, keepaliveMs);
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
        stopNow();
      }
    },
    settled: () => inFlight,
    stop: () => {
      if (stopped) return;
      stopped = true;
      stopNow();
    },
  };
}
