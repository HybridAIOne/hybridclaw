import { useEffect, useState } from 'react';
import type {
  A2ADeliveryDescriptor,
  A2ADeliveryState,
} from '../../api/chat-types';
import { fetchA2ADeliveryStatus } from '../../api/client';
import { cx } from '../../lib/cx';
import css from './chat-page.module.css';

const POLL_INTERVAL_MS = 2_000;
const RECEIVED_HOLD_MS = 1_200;
const DELIVERY_STATUS_CACHE_MAX_ENTRIES = 200;
// Stop polling after ~2 minutes; outbox retries back off well beyond a chat
// viewer's attention span, and a page reload re-reads the persisted state.
const MAX_POLLS = 60;

type A2ADeliveryDisplayState = 'sending' | 'received' | 'waiting' | 'failed';

function isTerminal(state: A2ADeliveryState): boolean {
  return state === 'delivered' || state === 'failed';
}

const LABELS: Record<A2ADeliveryDisplayState, string> = {
  sending: 'Sending',
  received: 'Received',
  waiting: 'Waiting',
  failed: 'Delivery failed',
};

interface A2ADeliveryStatusSnapshot {
  state: A2ADeliveryState;
  displayState: A2ADeliveryDisplayState;
  detail: string | null;
}

const deliveryStatusCache = new Map<string, A2ADeliveryStatusSnapshot>();

function cacheDeliveryStatus(
  messageId: string,
  snapshot: A2ADeliveryStatusSnapshot,
): void {
  if (deliveryStatusCache.has(messageId)) {
    deliveryStatusCache.delete(messageId);
  }
  deliveryStatusCache.set(messageId, snapshot);
  while (deliveryStatusCache.size > DELIVERY_STATUS_CACHE_MAX_ENTRIES) {
    const oldestKey = deliveryStatusCache.keys().next().value;
    if (!oldestKey) break;
    deliveryStatusCache.delete(oldestKey);
  }
}

function mergeDeliveryState(
  descriptorState: A2ADeliveryState,
  cachedState: A2ADeliveryState | null,
): A2ADeliveryState {
  if (descriptorState === 'failed' || cachedState === 'failed') return 'failed';
  if (descriptorState === 'delivered' || cachedState === 'delivered') {
    return 'delivered';
  }
  if (descriptorState === 'pending' || cachedState === 'pending') {
    return 'pending';
  }
  return 'unknown';
}

function initialDisplayState(
  state: A2ADeliveryState,
  cached: A2ADeliveryStatusSnapshot | null,
): A2ADeliveryDisplayState {
  if (state === 'failed') return 'failed';
  if (state !== 'delivered') return 'sending';
  return cached?.state === 'delivered' ? cached.displayState : 'received';
}

function initialStatusSnapshot(
  messageId: string,
  descriptorState: A2ADeliveryState,
): A2ADeliveryStatusSnapshot {
  const cached = deliveryStatusCache.get(messageId) ?? null;
  const state = mergeDeliveryState(descriptorState, cached?.state ?? null);
  return {
    state,
    displayState: initialDisplayState(state, cached),
    detail: state === cached?.state ? cached.detail : null,
  };
}

/**
 * Live delivery-status chip for an outbound A2A chat send. Starts from the
 * status the send returned and polls the outbox until the message reaches a
 * terminal state, so the bubble stops looking like a dead end.
 */
export function A2ADeliveryChip(props: {
  descriptor: A2ADeliveryDescriptor;
  token: string;
}) {
  const { descriptor, token } = props;
  const { messageId, status: descriptorStatus } = descriptor;
  const [initialSnapshot] = useState(() =>
    initialStatusSnapshot(messageId, descriptorStatus),
  );
  const [state, setState] = useState<A2ADeliveryState>(initialSnapshot.state);
  const [displayState, setDisplayState] = useState<A2ADeliveryDisplayState>(
    initialSnapshot.displayState,
  );
  const [detail, setDetail] = useState<string | null>(initialSnapshot.detail);

  useEffect(() => {
    const snapshot = initialStatusSnapshot(messageId, descriptorStatus);
    setState(snapshot.state);
    setDisplayState(snapshot.displayState);
    setDetail(snapshot.detail);
  }, [messageId, descriptorStatus]);

  useEffect(() => {
    if (state === 'failed') {
      setDisplayState('failed');
      cacheDeliveryStatus(messageId, {
        state,
        displayState: 'failed',
        detail,
      });
      return;
    }
    if (state !== 'delivered') {
      setDisplayState('sending');
      cacheDeliveryStatus(messageId, {
        state,
        displayState: 'sending',
        detail,
      });
      return;
    }
    const cached = deliveryStatusCache.get(messageId);
    if (cached?.state === 'delivered' && cached.displayState === 'waiting') {
      setDisplayState('waiting');
      return;
    }
    setDisplayState('received');
    cacheDeliveryStatus(messageId, {
      state,
      displayState: 'received',
      detail,
    });
    const timer = window.setTimeout(() => {
      setDisplayState('waiting');
      cacheDeliveryStatus(messageId, {
        state,
        displayState: 'waiting',
        detail,
      });
    }, RECEIVED_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [detail, messageId, state]);

  useEffect(() => {
    if (isTerminal(state)) return;
    let cancelled = false;
    let polls = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async (): Promise<void> => {
      polls += 1;
      try {
        const status = await fetchA2ADeliveryStatus(token, messageId);
        if (cancelled) return;
        if (status.status !== 'unknown') {
          setState(status.status);
          const nextDetail =
            status.status === 'failed'
              ? status.lastError ||
                (status.lastStatusCode ? `HTTP ${status.lastStatusCode}` : null)
              : null;
          setDetail(nextDetail);
          cacheDeliveryStatus(messageId, {
            state: status.status,
            displayState: initialDisplayState(status.status, null),
            detail: nextDetail,
          });
        }
        if (isTerminal(status.status) || polls >= MAX_POLLS) return;
      } catch {
        if (cancelled || polls >= MAX_POLLS) return;
      }
      timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // descriptor.messageId identifies the send; state drives the terminal guard.
  }, [messageId, token, state]);

  return (
    <div
      className={cx(
        css.a2aDeliveryChip,
        displayState === 'received' && css.a2aDeliveryChipDelivered,
        displayState === 'failed' && css.a2aDeliveryChipFailed,
      )}
      role="status"
      aria-live="polite"
      title={detail ?? undefined}
    >
      <span
        className={cx(
          css.a2aDeliveryDot,
          (displayState === 'sending' || displayState === 'waiting') &&
            css.a2aDeliveryDotPulse,
        )}
      />
      <span>{LABELS[displayState]}</span>
      {detail ? (
        <span className={css.a2aDeliveryDetail}>· {detail}</span>
      ) : null}
    </div>
  );
}
