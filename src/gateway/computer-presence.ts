/**
 * Whether the owner is at a computer: a chat page in a browser reports itself
 * (`POST /api/push/presence`) while it is visible and in use, and phone alerts
 * wait while any report is fresh. When the last page goes hidden, idle or
 * silent, each waiting alert whose notice is still unread rings after all, so
 * nothing written to a chat the computer does not show is lost.
 *
 * NOT the unread state (`web-notification-store.ts`): a waiting alert is
 * already recorded and broadcast; only its phone ring waits. In memory only:
 * after a restart nothing waits, and phones ring until the next report.
 */
import { logger } from '../logger.js';
import { readWebNotificationState } from './web-notification-store.js';

// 2026-10-08 (product owner asked that the phone stay quiet while they use the
// web chat): pages report every 30 s, so a page that stops reporting (lid
// shut, network gone) counts as away after one missed report and a margin.
// How long a page may sit without input is the page's call, not this module's.
export const PRESENCE_TTL_MS = 75_000;
const MAX_PAGES = 32;
const MAX_WAITING = 32;
const PAGE_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

interface WaitingAlert {
  /** The notice whose read state decides whether the alert still rings. */
  noticeId?: string;
  send: () => Promise<unknown>;
}

interface Presence {
  /** Page id → when its last report runs out. */
  pages: Map<string, number>;
  waiting: Map<string, WaitingAlert>;
  timer?: ReturnType<typeof setTimeout>;
}

const operators = new Map<string, Presence>();

export function isPresencePageId(value: unknown): value is string {
  return typeof value === 'string' && PAGE_PATTERN.test(value);
}

/** Rings what waited and is still unread, now that nobody is at a computer. */
function release(operatorId: string, waiting: WaitingAlert[]): void {
  let unread: Set<string>;
  try {
    unread = new Set(
      readWebNotificationState(operatorId).notifications.map(({ id }) => id),
    );
  } catch {
    logger.warn('Could not read notices; waiting phone alerts are dropped');
    return;
  }
  for (const alert of waiting) {
    if (alert.noticeId && !unread.has(alert.noticeId)) continue;
    void alert
      .send()
      .catch(() =>
        logger.warn('Phone push unavailable; notification remains in chat'),
      );
  }
}

function settle(operatorId: string, now = Date.now()): void {
  const presence = operators.get(operatorId);
  if (!presence) return;
  clearTimeout(presence.timer);
  for (const [page, until] of presence.pages)
    if (until <= now) presence.pages.delete(page);
  if (presence.pages.size) {
    const next = Math.min(...presence.pages.values());
    presence.timer = setTimeout(() => settle(operatorId), next - now);
    presence.timer.unref?.();
    return;
  }
  operators.delete(operatorId);
  if (presence.waiting.size)
    release(operatorId, [...presence.waiting.values()]);
}

/** A page's report: in use (`active`), or hidden, idle or closed. */
export function noteComputerPresence(
  operatorId: string,
  page: string,
  active: boolean,
  now = Date.now(),
): void {
  const presence = operators.get(operatorId) ?? {
    pages: new Map<string, number>(),
    waiting: new Map<string, WaitingAlert>(),
  };
  operators.set(operatorId, presence);
  presence.pages.delete(page);
  if (active) {
    presence.pages.set(page, now + PRESENCE_TTL_MS);
    // Oldest first: a flood of page ids only pushes out the oldest reports.
    for (const oldest of presence.pages.keys()) {
      if (presence.pages.size <= MAX_PAGES) break;
      presence.pages.delete(oldest);
    }
  }
  settle(operatorId, now);
}

export function isAtComputer(
  operatorId: string | null | undefined,
  now = Date.now(),
): boolean {
  const pages = operatorId ? operators.get(operatorId)?.pages : undefined;
  return [...(pages?.values() ?? [])].some((until) => until > now);
}

/**
 * Keeps a phone alert back while the owner is at a computer and answers true;
 * answers false, keeping nothing, when the caller should ring now. An alert
 * with the same key replaces the one waiting.
 */
export function waitWhileAtComputer(
  operatorId: string | null | undefined,
  key: string,
  alert: WaitingAlert,
): boolean {
  if (!operatorId || !isAtComputer(operatorId)) return false;
  const { waiting } = operators.get(operatorId) as Presence;
  waiting.delete(key);
  waiting.set(key, alert);
  for (const oldest of waiting.keys()) {
    if (waiting.size <= MAX_WAITING) break;
    waiting.delete(oldest);
  }
  return true;
}

export function resetComputerPresenceForTests(): void {
  for (const presence of operators.values()) clearTimeout(presence.timer);
  operators.clear();
}
