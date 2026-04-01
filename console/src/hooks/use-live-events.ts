import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { adminEventsUrl } from '../api/client';
import type { AdminOverview, GatewayStatus } from '../api/types';
import { gatewayStatusQueryOptions, overviewQueryOptions } from '../queries';

interface LiveState {
  connection: 'idle' | 'connecting' | 'open' | 'error';
  lastEventAt: number | null;
}

export function useLiveEvents(token: string): LiveState {
  const queryClient = useQueryClient();
  const [state, setState] = useState<LiveState>({
    connection: token ? 'connecting' : 'idle',
    lastEventAt: null,
  });

  useEffect(() => {
    if (!token) {
      setState({
        connection: 'idle',
        lastEventAt: null,
      });
      return;
    }

    const source = new EventSource(adminEventsUrl(token));
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
      queryClient.setQueryData(overviewQueryOptions(token).queryKey, payload);
      queryClient.setQueryData(
        gatewayStatusQueryOptions(token).queryKey,
        payload.status,
      );
      setState((current) => ({
        ...current,
        connection: 'open',
        lastEventAt: Date.now(),
      }));
    });

    source.addEventListener('status', (event) => {
      const payload = JSON.parse(
        (event as MessageEvent<string>).data,
      ) as GatewayStatus;
      queryClient.setQueryData(
        gatewayStatusQueryOptions(token).queryKey,
        payload,
      );
      setState((current) => ({
        ...current,
        connection: 'open',
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
  }, [queryClient, token]);

  return state;
}
