import { queryOptions } from '@tanstack/react-query';
import { fetchPlugins } from '../api/client';

export function pluginsQueryOptions(token: string) {
  return queryOptions({
    queryKey: ['admin', 'plugins', token] as const,
    queryFn: () => fetchPlugins(token),
    staleTime: 60_000,
  });
}
