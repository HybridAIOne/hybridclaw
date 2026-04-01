import { queryOptions } from '@tanstack/react-query';
import { fetchAudit } from '../api/client';

interface AuditQueryFilters {
  eventType: string;
  query: string;
  sessionId: string;
}

function normalizeFilter(value: string): string {
  return value.trim();
}

export function auditQueryOptions(
  token: string,
  filters: AuditQueryFilters,
  limit = 100,
) {
  const query = normalizeFilter(filters.query);
  const sessionId = normalizeFilter(filters.sessionId);
  const eventType = normalizeFilter(filters.eventType);

  return queryOptions({
    queryKey: [
      'admin',
      'audit',
      token,
      query,
      sessionId,
      eventType,
      limit,
    ] as const,
    queryFn: () =>
      fetchAudit(token, {
        query,
        sessionId,
        eventType,
        limit,
      }),
    staleTime: 5_000,
  });
}
