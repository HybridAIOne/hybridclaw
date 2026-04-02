import type { QueryClient } from '@tanstack/react-query';
import { queryOptions } from '@tanstack/react-query';
import { deleteMcpServer, fetchMcp, saveMcpServer } from '../api/client';
import type { AdminMcpConfig } from '../api/types';

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

export function saveMcpMutationOptions(queryClient: QueryClient, token: string) {
  return {
    mutationFn: (payload: { name: string; config: AdminMcpConfig }) =>
      saveMcpServer(token, payload),
    onSuccess: (updated: McpResponse) => {
      setMcpData(queryClient, token, updated);
    },
  };
}

export function deleteMcpMutationOptions(
  queryClient: QueryClient,
  token: string,
) {
  return {
    mutationFn: (name: string) => deleteMcpServer(token, name),
    onSuccess: (updated: McpResponse) => {
      setMcpData(queryClient, token, updated);
    },
  };
}
