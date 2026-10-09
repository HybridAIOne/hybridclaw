/**
 * Tells the gateway the owner is at this computer while the chat page is
 * visible and in use, so their phone stays quiet. Hidden (a locked screen
 * hides it too), idle or closed, the page says so and the phone rings again.
 * NOT the notification stream (`use-chat-notifications.ts`): nothing is read.
 */
import { useEffect } from 'react';
import { requestHeaders } from '../../api/client';

// 2026-10-08 (product owner asked that the phone stay quiet while they use the
// web chat): five minutes without a key or pointer counts as away. The gateway
// drops a page that stops reporting after 75 s (`computer-presence.ts`).
const IDLE_AFTER_MS = 5 * 60_000;
const REPORT_EVERY_MS = 30_000;
const INPUT_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel'];

export function useComputerPresence(token: string, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const page = Array.from(
      crypto.getRandomValues(new Uint8Array(16)),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('');
    let lastInput = Date.now();
    let reported = false;
    const report = (active: boolean) => {
      reported = active;
      void fetch('/api/push/presence', {
        method: 'POST',
        headers: requestHeaders(token, {}),
        body: JSON.stringify({ page, active }),
        // Survives the page closing, so the phone does not wait for a timeout.
        keepalive: true,
      }).catch(() => {});
    };
    const check = () => {
      const active =
        document.visibilityState === 'visible' &&
        Date.now() - lastInput < IDLE_AFTER_MS;
      if (active || reported) report(active);
    };
    const onInput = () => {
      const wasIdle = Date.now() - lastInput >= IDLE_AFTER_MS;
      lastInput = Date.now();
      if (wasIdle) check();
    };
    const onHide = () => {
      if (reported) report(false);
    };
    for (const name of INPUT_EVENTS)
      window.addEventListener(name, onInput, { passive: true });
    document.addEventListener('visibilitychange', check);
    window.addEventListener('pagehide', onHide);
    check();
    const timer = setInterval(check, REPORT_EVERY_MS);
    return () => {
      clearInterval(timer);
      for (const name of INPUT_EVENTS)
        window.removeEventListener(name, onInput);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('pagehide', onHide);
      onHide();
    };
  }, [token, enabled]);
}
