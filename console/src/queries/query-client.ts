import { MutationCache, QueryClient } from '@tanstack/react-query';

const DEFAULT_STALE_TIME = 30_000;
const DEFAULT_GC_TIME = 30 * 60 * 1000;

export function createQueryClient(): QueryClient {
  return new QueryClient({
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        // If the mutation has its own onError, don't show the global one
        if (mutation.options.onError) return;

        console.error('[Mutation Error]:', error);

        // Simple alert for unexpected mutation failures
        // In the future, this should be replaced with a toast notification
        alert(`Action failed: ${error.message}`);
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: DEFAULT_STALE_TIME,
        gcTime: DEFAULT_GC_TIME,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        retry: 1,
      },
    },
  });
}
