import type { QueryClient } from '@tanstack/react-query';
import { queryOptions } from '@tanstack/react-query';
import {
  fetchAdaptiveSkillAmendmentHistory,
  fetchAdaptiveSkillAmendments,
  fetchAdaptiveSkillHealth,
  fetchSkills,
} from '../api/client';

type SkillsResponse = Awaited<ReturnType<typeof fetchSkills>>;

export function skillsQueryOptions(token: string) {
  return queryOptions({
    queryKey: ['admin', 'skills', token] as const,
    queryFn: () => fetchSkills(token),
    staleTime: 60_000,
  });
}

export function adaptiveSkillsHealthQueryOptions(token: string) {
  return queryOptions({
    queryKey: ['admin', 'adaptive-skills-health', token] as const,
    queryFn: () => fetchAdaptiveSkillHealth(token),
    staleTime: 15_000,
  });
}

export function setSkillsData(
  queryClient: QueryClient,
  token: string,
  payload: SkillsResponse,
): void {
  queryClient.setQueryData(skillsQueryOptions(token).queryKey, payload);
}

export async function invalidateAdaptiveSkillsReviewData(
  queryClient: QueryClient,
  token: string,
  skillName: string,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: adaptiveSkillsHealthQueryOptions(token).queryKey,
    }),
    queryClient.invalidateQueries({
      queryKey: adaptiveSkillsAmendmentsQueryOptions(token).queryKey,
    }),
    queryClient.invalidateQueries({
      queryKey: adaptiveSkillsHistoryQueryOptions(token, skillName).queryKey,
    }),
  ]);
}

export function adaptiveSkillsAmendmentsQueryOptions(token: string) {
  return queryOptions({
    queryKey: ['admin', 'adaptive-skills-amendments', token] as const,
    queryFn: () => fetchAdaptiveSkillAmendments(token),
    staleTime: 15_000,
  });
}

export function adaptiveSkillsHistoryQueryOptions(
  token: string,
  skillName: string,
) {
  const normalizedSkillName = skillName.trim();

  return queryOptions({
    queryKey: [
      'admin',
      'adaptive-skills-history',
      token,
      normalizedSkillName,
    ] as const,
    queryFn: () =>
      fetchAdaptiveSkillAmendmentHistory(token, normalizedSkillName),
    enabled: normalizedSkillName.length > 0,
    staleTime: 15_000,
  });
}
