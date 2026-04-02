import type { QueryClient } from '@tanstack/react-query';
import { queryOptions } from '@tanstack/react-query';
import { fetchModels, saveModels } from '../api/client';

type ModelsResponse = Awaited<ReturnType<typeof fetchModels>>;

export function modelsQueryOptions(token: string) {
  return queryOptions({
    queryKey: ['admin', 'models', token] as const,
    queryFn: () => fetchModels(token),
    staleTime: 60_000,
  });
}

export function setModelsData(
  queryClient: QueryClient,
  token: string,
  payload: ModelsResponse,
): void {
  queryClient.setQueryData(modelsQueryOptions(token).queryKey, payload);
}

export function saveModelsMutationOptions(queryClient: QueryClient, token: string) {
  return {
    mutationFn: (payload: {
      defaultModel: string;
      hybridaiModels?: string[];
      codexModels?: string[];
    }) => saveModels(token, payload),
    onSuccess: (updated: ModelsResponse) => {
      setModelsData(queryClient, token, updated);
    },
  };
}
