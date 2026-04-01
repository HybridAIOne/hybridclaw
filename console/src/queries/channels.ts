import type { QueryClient } from '@tanstack/react-query';
import { queryOptions } from '@tanstack/react-query';
import { fetchChannels } from '../api/client';

type ChannelsResponse = Awaited<ReturnType<typeof fetchChannels>>;

export function channelsQueryOptions(token: string) {
  return queryOptions({
    queryKey: ['admin', 'channels', token] as const,
    queryFn: () => fetchChannels(token),
    staleTime: 60_000,
  });
}

export function setChannelsData(
  queryClient: QueryClient,
  token: string,
  payload: ChannelsResponse,
): void {
  queryClient.setQueryData(channelsQueryOptions(token).queryKey, payload);
}
