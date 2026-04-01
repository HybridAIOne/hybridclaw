import type { QueryClient } from '@tanstack/react-query';
import { queryOptions } from '@tanstack/react-query';
import { fetchOverview } from '../api/client';

type OverviewResponse = Awaited<ReturnType<typeof fetchOverview>>;

export function overviewQueryOptions(token: string) {
  return queryOptions({
    queryKey: ['admin', 'overview', token] as const,
    queryFn: () => fetchOverview(token),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}

export function setOverviewData(
  queryClient: QueryClient,
  token: string,
  payload: OverviewResponse,
): void {
  queryClient.setQueryData(overviewQueryOptions(token).queryKey, payload);
}

export function invalidateOverview(
  queryClient: QueryClient,
  token: string,
): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: overviewQueryOptions(token).queryKey,
  });
}
