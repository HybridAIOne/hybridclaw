import type { QueryClient } from '@tanstack/react-query';
import { queryOptions } from '@tanstack/react-query';
import { fetchConfig } from '../api/client';

type ConfigResponse = Awaited<ReturnType<typeof fetchConfig>>;

export function configQueryOptions(token: string) {
  return queryOptions({
    queryKey: ['admin', 'config', token] as const,
    queryFn: () => fetchConfig(token),
    staleTime: 5 * 60_000,
  });
}

export function setConfigData(
  queryClient: QueryClient,
  token: string,
  payload: ConfigResponse,
): void {
  queryClient.setQueryData(configQueryOptions(token).queryKey, payload);
}
