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
// Stop polling after ~2 minutes; outbox retries back off well beyond a chat
// viewer's attention span, and a page reload re-reads the persisted state.
const MAX_POLLS = 60;

type A2ADeliveryDisplayState =
  | 'sending'
  | 'received'
  | 'waiting'
  | 'failed';

function isTerminal(state: A2ADeliveryState): boolean {
  return state === 'delivered' || state === 'failed';
}

const LABELS: Record<A2ADeliveryDisplayState, string> = {
  sending: 'Sending',
  received: 'Received',
  waiting: 'Waiting',
  failed: 'Delivery failed',
};

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
  const [state, setState] = useState<A2ADeliveryState>(descriptor.status);
  const [displayState, setDisplayState] = useState<A2ADeliveryDisplayState>(
    descriptor.status === 'failed'
      ? 'failed'
      : descriptor.status === 'delivered'
        ? 'received'
        : 'sending',
  );
  const [detail, setDetail] = useState<string | null>(null);

  useEffect(() => {
    setState(descriptor.status);
  }, [descriptor.status]);

  useEffect(() => {
    if (state === 'failed') {
      setDisplayState('failed');
      return;
    }
    if (state !== 'delivered') {
      setDisplayState('sending');
      return;
    }
    setDisplayState('received');
    const timer = window.setTimeout(
      () => setDisplayState('waiting'),
      RECEIVED_HOLD_MS,
    );
    return () => window.clearTimeout(timer);
  }, [state]);

  useEffect(() => {
    if (isTerminal(state)) return;
    let cancelled = false;
    let polls = 0;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async (): Promise<void> => {
      polls += 1;
      try {
        const status = await fetchA2ADeliveryStatus(
          token,
          descriptor.messageId,
        );
        if (cancelled) return;
        if (status.status !== 'unknown') {
          setState(status.status);
          setDetail(
            status.status === 'failed'
              ? status.lastError ||
                  (status.lastStatusCode
                    ? `HTTP ${status.lastStatusCode}`
                    : null)
              : null,
          );
        }
        if (isTerminal(status.status) || polls >= MAX_POLLS) return;
      } catch {
        if (cancelled || polls >= MAX_POLLS) return;
      }
      timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };

    timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // descriptor.messageId identifies the send; state drives the terminal guard.
  }, [descriptor.messageId, token, state]);

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
