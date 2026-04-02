import type { QueryClient } from '@tanstack/react-query';
import { queryOptions } from '@tanstack/react-query';
import { fetchConfig, saveConfig } from '../api/client';
import type { AdminConfig, AdminConfigResponse } from '../api/types';

type ConfigResponse = AdminConfigResponse;

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

export function saveConfigMutationOptions(queryClient: QueryClient, token: string) {
  return {
    mutationFn: (config: AdminConfig) => saveConfig(token, config),
    onSuccess: (updatedConfig: ConfigResponse) => {
      setConfigData(queryClient, token, updatedConfig);
    },
  };
}
