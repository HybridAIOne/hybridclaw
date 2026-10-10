/**
 * Calls Hy places to the user's phone (`call_user`): the store of record for
 * each one. A call leaves `ringing` exactly once, for `answered`, `declined`,
 * `missed` or `failed`; an answered call stays live until its last voice
 * stream ends. Busy and rate-limit answers are read from here.
 *
 * Gateway memory on purpose: a call rings for 40 seconds and its tool call
 * waits on it in the same process, so a restart loses nothing that could
 * still be answered.
 *
 * NOT the push path (`mobile-push.ts` rings the phones) nor the voice stream
 * (`webchat-voice.ts` joins an answered call); this only decides what state a
 * call is in and whether another may ring.
 */
import { randomUUID } from 'node:crypto';

export type PhoneCallState =
  | 'ringing'
  | 'answered'
  | 'declined'
  | 'missed'
  | 'failed';

export interface PhoneCall {
  callId: string;
  operatorId: string;
  sessionId: string;
  agentId: string;
  reason: string;
  opening: string | null;
  notes: string | null;
  asked: boolean;
  createdAt: number;
  expiresAt: number;
  state: PhoneCallState;
}

// 40 s ring, 20 s grace for the waiting tool, at most 3 unanswered calls an
// hour (contract "Hy calls you", product owner, 2026-10-10). Per-user tuning
// deferred until there are real calls to learn from.
export const PHONE_CALL_RING_MS = 40_000;
const WAIT_GRACE_MS = 20_000;
const UNANSWERED_LIMIT = 3;
const UNANSWERED_WINDOW_MS = 60 * 60_000;

interface Entry {
  call: PhoneCall;
  /** Voice streams joined to this call (`answered` only). */
  streams: number;
  missTimer: NodeJS.Timeout | null;
  waiters: Array<(state: PhoneCallState) => void>;
}

const entries = new Map<string, Entry>();

function prune(now: number): void {
  for (const [callId, entry] of entries) {
    const settledLongAgo =
      entry.call.state !== 'ringing' &&
      entry.streams === 0 &&
      entry.call.createdAt < now - UNANSWERED_WINDOW_MS;
    if (settledLongAgo) entries.delete(callId);
  }
}

function settle(entry: Entry, state: PhoneCallState): void {
  if (entry.call.state !== 'ringing') return;
  entry.call.state = state;
  if (entry.missTimer) clearTimeout(entry.missTimer);
  entry.missTimer = null;
  for (const resolve of entry.waiters.splice(0)) resolve(state);
}

/**
 * Why another call for this operator may not ring now: one is still ringing or
 * live (`busy`), or too many went unanswered in the last hour.
 */
export function phoneCallRefusal(
  operatorId: string,
  now = Date.now(),
): 'busy' | 'rate_limited' | null {
  prune(now);
  let unanswered = 0;
  for (const { call, streams } of entries.values()) {
    if (call.operatorId !== operatorId) continue;
    if (call.state === 'ringing' || streams > 0) return 'busy';
    if (
      (call.state === 'declined' || call.state === 'missed') &&
      call.createdAt > now - UNANSWERED_WINDOW_MS
    )
      unanswered += 1;
  }
  return unanswered >= UNANSWERED_LIMIT ? 'rate_limited' : null;
}

/** A new ringing call; it turns `missed` once it has rung unanswered. */
export function createPhoneCall(
  input: Omit<PhoneCall, 'callId' | 'createdAt' | 'expiresAt' | 'state'>,
  now = Date.now(),
): PhoneCall {
  const call: PhoneCall = {
    ...input,
    callId: randomUUID(),
    createdAt: now,
    expiresAt: now + PHONE_CALL_RING_MS,
    state: 'ringing',
  };
  const entry: Entry = { call, streams: 0, missTimer: null, waiters: [] };
  entry.missTimer = setTimeout(
    () => settle(entry, 'missed'),
    PHONE_CALL_RING_MS,
  );
  entry.missTimer.unref?.();
  entries.set(call.callId, entry);
  return { ...call };
}

/** No phone took the push, so nothing rings. */
export function failPhoneCall(callId: string): void {
  const entry = entries.get(callId);
  if (entry) settle(entry, 'failed');
}

/**
 * The outcome the tool waits for: the state once it leaves `ringing`, or after
 * the ring time and a grace period, whatever it is then (`missed`).
 */
export function waitForPhoneCall(callId: string): Promise<PhoneCallState> {
  const entry = entries.get(callId);
  if (!entry) return Promise.resolve('failed');
  if (entry.call.state !== 'ringing') return Promise.resolve(entry.call.state);
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => {
        settle(entry, 'missed');
        resolve(entry.call.state);
      },
      Math.max(0, entry.call.expiresAt + WAIT_GRACE_MS - Date.now()),
    );
    timer.unref?.();
    entry.waiters.push((state) => {
      clearTimeout(timer);
      resolve(state);
    });
  });
}

/**
 * The user picked up: a voice stream of the same operator names the call.
 * Joins a ringing or already answered call; anything else (unknown, over,
 * another operator's) is null, and the stream goes on as an ordinary call.
 * Each joined stream must `leavePhoneCall` when it ends.
 */
export function answerPhoneCall(
  callId: string,
  operatorId: string | null | undefined,
): PhoneCall | null {
  const entry = entries.get(callId);
  if (!entry || !operatorId || entry.call.operatorId !== operatorId)
    return null;
  if (entry.call.state !== 'ringing' && entry.call.state !== 'answered')
    return null;
  if (entry.call.state === 'ringing' && Date.now() >= entry.call.expiresAt)
    return null;
  settle(entry, 'answered');
  entry.streams += 1;
  return { ...entry.call };
}

/** A joined voice stream ended; the call is over when the last one has. */
export function leavePhoneCall(callId: string): void {
  const entry = entries.get(callId);
  if (entry && entry.streams > 0) entry.streams -= 1;
}

/** The user declined a ringing call of theirs; false when none rings. */
export function declinePhoneCall(
  callId: string,
  operatorId: string | null | undefined,
): boolean {
  const entry = entries.get(callId);
  if (
    !entry ||
    !operatorId ||
    entry.call.operatorId !== operatorId ||
    entry.call.state !== 'ringing'
  )
    return false;
  settle(entry, 'declined');
  return true;
}

export function resetPhoneCallsForTests(): void {
  for (const entry of entries.values())
    if (entry.missTimer) clearTimeout(entry.missTimer);
  entries.clear();
}
