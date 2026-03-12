import type { WASocket } from '@whiskeysockets/baileys';
import { logger } from '../../logger.js';

export interface WhatsAppTypingController {
  start: () => void;
  stop: () => void;
}

interface CreateWhatsAppTypingControllerOptions {
  keepaliveMs?: number;
  ttlMs?: number;
}

const DEFAULT_KEEPALIVE_MS = 10_000;
const DEFAULT_TTL_MS = 60_000;

export function createWhatsAppTypingController(
  getSocket: () => Pick<WASocket, 'sendPresenceUpdate'> | null,
  jid: string,
  options?: CreateWhatsAppTypingControllerOptions,
): WhatsAppTypingController {
  const chatJid = jid.trim();
  if (!chatJid) {
    return {
      start: () => {},
      stop: () => {},
    };
  }

  const keepaliveMs = Math.max(
    4_000,
    Math.floor(options?.keepaliveMs ?? DEFAULT_KEEPALIVE_MS),
  );
  const ttlMs = Math.max(10_000, Math.floor(options?.ttlMs ?? DEFAULT_TTL_MS));

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

  const sendPresence = async (state: 'composing' | 'paused'): Promise<void> => {
    const socket = getSocket();
    if (!socket) return;
    try {
      await socket.sendPresenceUpdate(state, chatJid);
    } catch (error) {
      logger.debug(
        { error, channel: 'whatsapp', jid: chatJid, state },
        'Failed to send WhatsApp typing indicator',
      );
    }
  };

  const stopNow = (): void => {
    active = false;
    clearTimers();
    void sendPresence('paused');
  };

  return {
    start: () => {
      if (stopped || active) return;
      active = true;
      void sendPresence('composing');
      keepaliveTimer = setInterval(() => {
        if (!active || stopped) return;
        void sendPresence('composing');
      }, keepaliveMs);
      ttlTimer = setTimeout(() => {
        if (!active || stopped) return;
        stopNow();
      }, ttlMs);
    },
    stop: () => {
      if (stopped) return;
      if (!active) {
        clearTimers();
        stopped = true;
        return;
      }
      stopNow();
      stopped = true;
    },
  };
}
