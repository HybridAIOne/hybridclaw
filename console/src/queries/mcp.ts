import type { QueryClient } from '@tanstack/react-query';
import { queryOptions } from '@tanstack/react-query';
import { fetchMcp } from '../api/client';

type McpResponse = Awaited<ReturnType<typeof fetchMcp>>;

export function mcpQueryOptions(token: string) {
  return queryOptions({
    queryKey: ['admin', 'mcp', token] as const,
    queryFn: () => fetchMcp(token),
    staleTime: 60_000,
  });
}

export function setMcpData(
  queryClient: QueryClient,
  token: string,
  payload: McpResponse,
): void {
  queryClient.setQueryData(mcpQueryOptions(token).queryKey, payload);
}
