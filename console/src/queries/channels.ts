import type { QueryClient } from '@tanstack/react-query';
import { queryOptions } from '@tanstack/react-query';
import { deleteChannel, fetchChannels, saveChannel } from '../api/client';
import type {
  AdminChannelConfig,
  AdminChannelTransport,
  AdminChannelsResponse,
} from '../api/types';

type ChannelsResponse = AdminChannelsResponse;

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

export function saveChannelsMutationOptions(queryClient: QueryClient, token: string) {
  return {
    mutationFn: (payload: {
      transport: AdminChannelTransport;
      guildId: string;
      channelId: string;
      config: AdminChannelConfig;
    }) => saveChannel(token, payload),
    onSuccess: (updated: ChannelsResponse) => {
      setChannelsData(queryClient, token, updated);
    },
  };
}

export function deleteChannelMutationOptions(queryClient: QueryClient, token: string) {
  return {
    mutationFn: (payload: {
      transport: AdminChannelTransport;
      guildId: string;
      channelId: string;
    }) =>
      deleteChannel(
        token,
        payload.transport,
        payload.guildId,
        payload.channelId,
      ),
    onSuccess: (updated: ChannelsResponse) => {
      setChannelsData(queryClient, token, updated);
    },
  };
}
