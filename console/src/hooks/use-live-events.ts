import { useEffect, useState } from 'react';
import { adminEventsUrl } from '../api/client';
import type { AdminOverview, GatewayStatus } from '../api/types';

interface LiveState {
  connection: 'idle' | 'connecting' | 'open' | 'error';
  overview: AdminOverview | null;
  status: GatewayStatus | null;
  lastEventAt: number | null;
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
    const source = new EventSource(adminEventsUrl(trimmedToken));
    setState((current) => ({
      ...current,
      connection: 'connecting',
    }));

    source.addEventListener('open', () => {
      setState((current) => ({
        ...current,
        connection: 'open',
      }));
    });

    source.addEventListener('overview', (event) => {
      const payload = JSON.parse(
        (event as MessageEvent<string>).data,
      ) as AdminOverview;
      setState((current) => ({
        ...current,
        connection: 'open',
        overview: payload,
        lastEventAt: Date.now(),
      }));
    });

    source.addEventListener('status', (event) => {
      const payload = JSON.parse(
        (event as MessageEvent<string>).data,
      ) as GatewayStatus;
      setState((current) => ({
        ...current,
        connection: 'open',
        status: payload,
        lastEventAt: Date.now(),
      }));
    });

    source.addEventListener('error', () => {
      setState((current) => ({
        ...current,
        connection: 'error',
      }));
    });

    return () => {
      source.close();
    };
  }, [trimmedToken]);

  return state;
}
