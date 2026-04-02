import {
  type DefaultError,
  type QueryKey,
  type UseMutationOptions,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
  type UseSuspenseQueryOptions,
  type UseSuspenseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { useAuth } from '../auth';

export function useAdminToken(): string {
  return useAuth().token;
}

export function useAdminQueryClient() {
  return useQueryClient();
}

/**
 * A wrapper around useQuery that automatically injects the admin token.
 * Pass a function that receives the token and returns the query options.
 */
export function useAdminQuery<
  TQueryFnData = unknown,
  TError = DefaultError,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(
  optionsFactory: (
    token: string,
  ) => UseQueryOptions<TQueryFnData, TError, TData, TQueryKey>,
): UseQueryResult<TData, TError> {
  const token = useAdminToken();
  return useQuery(optionsFactory(token));
}

/**
 * A wrapper around useMutation that automatically injects the admin token.
 * Pass a function that receives the token and returns the mutation options.
 */
export function useAdminMutation<
  TData = unknown,
  TError = DefaultError,
  TVariables = void,
  TContext = unknown,
>(
  optionsFactory: (
    token: string,
  ) => UseMutationOptions<TData, TError, TVariables, TContext>,
): UseMutationResult<TData, TError, TVariables, TContext> {
  const token = useAdminToken();
  return useMutation(optionsFactory(token));
}

/**
 * A wrapper around useSuspenseQuery that automatically injects the admin token.
 * Pass a function that receives the token and returns the query options.
 */
export function useAdminSuspenseQuery<
  TQueryFnData = unknown,
  TError = DefaultError,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(
  optionsFactory: (
    token: string,
  ) => UseSuspenseQueryOptions<TQueryFnData, TError, TData, TQueryKey>,
): UseSuspenseQueryResult<TData, TError> {
  const token = useAdminToken();
  return useSuspenseQuery(optionsFactory(token));
}
