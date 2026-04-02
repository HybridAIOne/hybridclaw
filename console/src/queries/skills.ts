import type { QueryClient } from '@tanstack/react-query';
import { queryOptions } from '@tanstack/react-query';
import {
  applyAdaptiveSkillAmendment,
  fetchAdaptiveSkillAmendmentHistory,
  fetchAdaptiveSkillAmendments,
  fetchAdaptiveSkillHealth,
  fetchSkills,
  rejectAdaptiveSkillAmendment,
  saveSkillEnabled,
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

export function reviewSkillMutationOptions(queryClient: QueryClient, token: string) {
  return {
    mutationFn: (variables: {
      action: 'apply' | 'reject';
      skillName: string;
      reviewedBy?: string;
    }) =>
      variables.action === 'apply'
        ? applyAdaptiveSkillAmendment(
            token,
            variables.skillName,
            variables.reviewedBy,
          )
        : rejectAdaptiveSkillAmendment(
            token,
            variables.skillName,
            variables.reviewedBy,
          ),
    onSuccess: (_: unknown, variables: { skillName: string }) => {
      invalidateAdaptiveSkillsReviewData(
        queryClient,
        token,
        variables.skillName,
      );
    },
  };
}

export function toggleSkillMutationOptions(queryClient: QueryClient, token: string) {
  return {
    mutationFn: (variables: { name: string; enabled: boolean }) =>
      saveSkillEnabled(token, variables),
    onSuccess: (updatedSkills: SkillsResponse) => {
      setSkillsData(queryClient, token, updatedSkills);
    },
  };
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
