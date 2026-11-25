/**
 * Live admin-event stream reader for `/api/events` over `fetch` + SSE.
 *
 * Sends the in-memory bearer token via `Authorization` (never in the URL) while
 * keeping `credentials: 'same-origin'` so cookie-backed sessions continue to work.
 * Stops retrying on 401/403 (dispatching auth-required on 401) and reconnects
 * with bounded exponential backoff on transient disconnects.
 *
 * NOT the chat notification stream (`routes/chat/use-chat-notifications.ts`);
 * this hook only tracks gateway `overview` and `status` snapshots.
 */

import {
  readServerSentEvents,
  type ServerSentEvent,
} from '@hybridclaw/shared/provider-wire/server-sent-events';
import { useEffect, useState } from 'react';
import {
  dispatchAuthRequired,
  readErrorResponseMessage,
  requestHeaders,
} from '../api/client';
import type { AdminOverview, GatewayStatus } from '../api/types';

export type LiveConnection = 'idle' | 'connecting' | 'open' | 'error';

interface LiveState {
  connection: LiveConnection;
  overview: AdminOverview | null;
  status: GatewayStatus | null;
  lastEventAt: number | null;
}

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

function parseEventPayload<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

export function useLiveEvents(token: string): LiveState {
  const trimmedToken = token.trim();
  const [state, setState] = useState<LiveState>({
    connection: 'connecting',
    overview: null,
    status: null,
    lastEventAt: null,
  });

  useEffect(() => {
    const controller = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let attempt = 0;

    setState((current) => ({
      ...current,
      connection: 'connecting',
    }));

    const handleFrame = (frame: ServerSentEvent): void => {
      if (frame.event === 'overview') {
        const payload = parseEventPayload<AdminOverview>(frame.data);
        if (!payload) return;
        setState((current) => ({
          ...current,
          connection: 'open',
          overview: payload,
          lastEventAt: Date.now(),
        }));
        return;
      }

      if (frame.event === 'status') {
        const payload = parseEventPayload<GatewayStatus>(frame.data);
        if (!payload) return;
        setState((current) => ({
          ...current,
          connection: 'open',
          status: payload,
          lastEventAt: Date.now(),
        }));
      }
    };

    const scheduleReconnect = (): void => {
      if (controller.signal.aborted) return;
      setState((current) => ({
        ...current,
        connection: 'error',
      }));
      const delay = Math.min(
        INITIAL_RECONNECT_DELAY_MS * 2 ** attempt,
        MAX_RECONNECT_DELAY_MS,
      );
      attempt += 1;
      retryTimer = setTimeout(() => {
        void connect();
      }, delay);
    };

    const connect = async (): Promise<void> => {
      if (controller.signal.aborted) return;
      try {
        const response = await fetch('/api/events', {
          headers: {
            ...requestHeaders(trimmedToken),
            Accept: 'text/event-stream',
          },
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => {});
          return;
        }

        if (response.status === 401) {
          const message = await readErrorResponseMessage(response);
          if (controller.signal.aborted) return;
          setState((current) => ({
            ...current,
            connection: 'error',
          }));
          dispatchAuthRequired(message);
          return;
        }

        if (response.status === 403) {
          void response.body?.cancel().catch(() => {});
          setState((current) => ({
            ...current,
            connection: 'error',
          }));
          return;
        }

        if (!response.ok || !response.body) {
          void response.body?.cancel().catch(() => {});
          scheduleReconnect();
          return;
        }

        attempt = 0;
        setState((current) => ({
          ...current,
          connection: 'open',
        }));

        const reader = response.body.getReader();
        activeReader = reader;
        try {
          for await (const frame of readServerSentEvents(() => reader.read())) {
            if (controller.signal.aborted) return;
            handleFrame(frame);
          }
        } finally {
          if (activeReader === reader) {
            activeReader = null;
          }
          reader.releaseLock();
        }

        scheduleReconnect();
      } catch {
        scheduleReconnect();
      }
    };

    void connect();

    return () => {
      controller.abort();
      clearTimeout(retryTimer);
      const reader = activeReader;
      activeReader = null;
      if (reader) {
        void reader.cancel().catch(() => {});
      }
    };
  }, [trimmedToken]);

  return state;
}
