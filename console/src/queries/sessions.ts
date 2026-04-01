import type { QueryClient } from '@tanstack/react-query';
import { queryOptions } from '@tanstack/react-query';
import { fetchSessions } from '../api/client';

type SessionsResponse = Awaited<ReturnType<typeof fetchSessions>>;

export function sessionsQueryOptions(token: string) {
  return queryOptions({
    queryKey: ['admin', 'sessions', token] as const,
    queryFn: () => fetchSessions(token),
    staleTime: 30_000,
  });
}

export function setSessionsData(
  queryClient: QueryClient,
  token: string,
  payload: SessionsResponse,
): void {
  queryClient.setQueryData(sessionsQueryOptions(token).queryKey, payload);
}

export function invalidateSessions(
  queryClient: QueryClient,
  token: string,
): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: sessionsQueryOptions(token).queryKey,
  });
}
