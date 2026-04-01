import { queryOptions } from '@tanstack/react-query';
import { fetchTools } from '../api/client';

export function toolsQueryOptions(token: string) {
  return queryOptions({
    queryKey: ['admin', 'tools', token] as const,
    queryFn: () => fetchTools(token),
    staleTime: 30_000,
  });
}
