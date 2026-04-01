import { queryOptions } from '@tanstack/react-query';
import { validateToken } from '../api/client';

export function gatewayStatusQueryOptions(token: string) {
  return queryOptions({
    queryKey: ['admin', 'gateway-status', token] as const,
    queryFn: () => validateToken(token),
    staleTime: 10_000,
  });
}
