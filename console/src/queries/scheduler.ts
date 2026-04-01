import type { QueryClient } from '@tanstack/react-query';
import { queryOptions } from '@tanstack/react-query';
import { fetchJobsContext, fetchScheduler } from '../api/client';
import type { AdminSchedulerJob } from '../api/types';

type SchedulerResponse = Awaited<ReturnType<typeof fetchScheduler>>;
type JobsContextResponse = Awaited<ReturnType<typeof fetchJobsContext>>;

export function schedulerQueryOptions(token: string) {
  return queryOptions({
    queryKey: ['admin', 'scheduler', token] as const,
    queryFn: () => fetchScheduler(token),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
}

export function jobsContextQueryOptions(token: string) {
  return queryOptions({
    queryKey: ['admin', 'jobs-context', token] as const,
    queryFn: () => fetchJobsContext(token),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
}

export function setSchedulerData(
  queryClient: QueryClient,
  token: string,
  payload: SchedulerResponse,
): void {
  queryClient.setQueryData(schedulerQueryOptions(token).queryKey, payload);
}

export function getSchedulerData(
  queryClient: QueryClient,
  token: string,
): SchedulerResponse | undefined {
  return queryClient.getQueryData(schedulerQueryOptions(token).queryKey);
}

export function setJobsContextData(
  queryClient: QueryClient,
  token: string,
  payload: JobsContextResponse,
): void {
  queryClient.setQueryData(jobsContextQueryOptions(token).queryKey, payload);
}

export function cancelSchedulerData(
  queryClient: QueryClient,
  token: string,
): Promise<void> {
  return queryClient.cancelQueries({
    queryKey: schedulerQueryOptions(token).queryKey,
  });
}

export function replaceSchedulerJobInCache(
  queryClient: QueryClient,
  token: string,
  nextJob: AdminSchedulerJob,
): SchedulerResponse | undefined {
  const previous = getSchedulerData(queryClient, token);
  if (!previous) return previous;
  setSchedulerData(queryClient, token, {
    ...previous,
    jobs: previous.jobs.map((job) =>
      job.id === nextJob.id && job.source === 'config' ? nextJob : job,
    ),
  });
  return previous;
}
