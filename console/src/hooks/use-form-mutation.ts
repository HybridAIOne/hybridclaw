import {
  type QueryKey,
  type UseMutationResult,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';

export type UseFormMutationOptions<TInput, TOutput> = {
  mutationFn: (input: TInput) => Promise<TOutput>;
  onSuccess?: (output: TOutput, input: TInput) => void;
  onError?: (error: Error, input: TInput) => void;
  /**
   * Sibling query keys that depend on the data this mutation writes. Each
   * is passed to `queryClient.invalidateQueries` after the mutation
   * succeeds, so dashboards / overview pages stay fresh without manual
   * coordination at every call site.
   */
  invalidates?: ReadonlyArray<QueryKey>;
};

/**
 * Thin wrapper around `useMutation` that standardises the "save → invalidate
 * sibling queries → bubble error up" pattern across admin forms.
 *
 * Pair with `useFormDraft.commit` to reset the draft to whatever the server
 * confirmed (which may differ from the request, e.g. server-side normalisation):
 *
 *   const save = useFormMutation({
 *     mutationFn: (config) => saveConfig(token, config),
 *     onSuccess: (payload) => commit(payload.config),
 *     invalidates: [['overview'], ['dashboard']],
 *   });
 */
export function useFormMutation<TInput, TOutput>(
  opts: UseFormMutationOptions<TInput, TOutput>,
): UseMutationResult<TOutput, Error, TInput> {
  const queryClient = useQueryClient();
  return useMutation({
    // Normalize non-Error rejections at the source: React Query stores
    // whatever the mutationFn throws verbatim in `result.error`, so wrapping
    // here (not just in onError) keeps the returned mutation state's `.error`
    // consistent with the hook's `Error`-typed contract.
    mutationFn: async (input: TInput) => {
      try {
        return await opts.mutationFn(input);
      } catch (error) {
        throw error instanceof Error
          ? error
          : new Error(String(error), { cause: error });
      }
    },
    onSuccess: (output, input) => {
      opts.onSuccess?.(output, input);
      for (const key of opts.invalidates ?? []) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
    onError: (error, input) => {
      // mutationFn above guarantees an Error instance reaches here.
      opts.onError?.(error, input);
    },
  });
}
