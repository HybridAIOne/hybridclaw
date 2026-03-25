import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDeferredValue, useState } from 'react';
import {
  applyAdaptiveSkillAmendment,
  fetchAdaptiveSkillAmendmentHistory,
  fetchAdaptiveSkillAmendments,
  fetchAdaptiveSkillHealth,
  fetchSkills,
  rejectAdaptiveSkillAmendment,
  saveSkillEnabled,
} from '../api/client';
import type {
  AdminAdaptiveSkillAmendment,
  AdminAdaptiveSkillHealthMetric,
} from '../api/types';
import { useAuth } from '../auth';
import {
  Banner,
  BooleanPill,
  BooleanToggle,
  Button,
  EmptyState,
  KeyValueGrid,
  KeyValueItem,
  MetricCard,
  PageHeader,
  Panel,
} from '../components/ui';
import { formatDateTime, formatRelativeTime } from '../lib/format';

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatFeedbackCounts(metrics: AdminAdaptiveSkillHealthMetric): string {
  return `+${metrics.positive_feedback_count} / -${metrics.negative_feedback_count}`;
}

function formatAmendmentStatus(amendment: AdminAdaptiveSkillAmendment): string {
  return `${amendment.status} · v${amendment.version}`;
}

function formatAmendmentTiming(amendment: AdminAdaptiveSkillAmendment): string {
  const relevantTimestamp =
    amendment.applied_at ||
    amendment.rejected_at ||
    amendment.rolled_back_at ||
    amendment.updated_at ||
    amendment.created_at;
  return formatRelativeTime(relevantTimestamp);
}

export function SkillsPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState('');
  const [selectedSkillName, setSelectedSkillName] = useState('');
  const deferredFilter = useDeferredValue(filter);
  const filterNeedle = deferredFilter.trim().toLowerCase();

  const skillsQuery = useQuery({
    queryKey: ['skills', auth.token],
    queryFn: () => fetchSkills(auth.token),
  });

  const healthQuery = useQuery({
    queryKey: ['adaptive-skills-health', auth.token],
    queryFn: () => fetchAdaptiveSkillHealth(auth.token),
  });

  const stagedAmendmentsQuery = useQuery({
    queryKey: ['adaptive-skills-amendments', auth.token],
    queryFn: () => fetchAdaptiveSkillAmendments(auth.token),
  });

  const toggleMutation = useMutation({
    mutationFn: (payload: { name: string; enabled: boolean }) =>
      saveSkillEnabled(auth.token, payload),
    onSuccess: (payload) => {
      queryClient.setQueryData(['skills', auth.token], payload);
    },
  });

  const reviewMutation = useMutation({
    mutationFn: async (payload: {
      action: 'apply' | 'reject';
      skillName: string;
    }) =>
      payload.action === 'apply'
        ? applyAdaptiveSkillAmendment(auth.token, payload.skillName)
        : rejectAdaptiveSkillAmendment(auth.token, payload.skillName),
    onSuccess: async (_payload, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['adaptive-skills-health', auth.token],
        }),
        queryClient.invalidateQueries({
          queryKey: ['adaptive-skills-amendments', auth.token],
        }),
        queryClient.invalidateQueries({
          queryKey: [
            'adaptive-skills-history',
            auth.token,
            variables.skillName,
          ],
        }),
      ]);
    },
  });

  const healthMetrics = healthQuery.data?.metrics || [];
  const stagedAmendments = stagedAmendmentsQuery.data?.amendments || [];
  const knownSkillNames = new Set([
    ...(skillsQuery.data?.skills || []).map((skill) => skill.name),
    ...healthMetrics.map((metrics) => metrics.skill_name),
    ...stagedAmendments.map((amendment) => amendment.skill_name),
  ]);
  const effectiveSelectedSkillName =
    selectedSkillName && knownSkillNames.has(selectedSkillName)
      ? selectedSkillName
      : stagedAmendments[0]?.skill_name ||
        healthMetrics[0]?.skill_name ||
        skillsQuery.data?.skills[0]?.name ||
        '';

  const historyQuery = useQuery({
    queryKey: [
      'adaptive-skills-history',
      auth.token,
      effectiveSelectedSkillName,
    ],
    queryFn: () =>
      fetchAdaptiveSkillAmendmentHistory(
        auth.token,
        effectiveSelectedSkillName,
      ),
    enabled: Boolean(effectiveSelectedSkillName),
  });

  const filteredSkills = (skillsQuery.data?.skills || []).filter((skill) => {
    const haystack = [
      skill.name,
      skill.description,
      skill.source,
      ...(skill.tags || []),
      ...(skill.relatedSkills || []),
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(filterNeedle);
  });

  const filteredHealthMetrics = healthMetrics.filter((metrics) => {
    const haystack = [
      metrics.skill_name,
      ...metrics.degradation_reasons,
      ...metrics.error_clusters.map((cluster) => cluster.category),
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(filterNeedle);
  });

  const degradedSkillCount = healthMetrics.filter(
    (metrics) => metrics.degraded,
  ).length;
  const selectedMetrics = healthMetrics.find(
    (metrics) => metrics.skill_name === effectiveSelectedSkillName,
  );
  const historyEntries = historyQuery.data?.amendments || [];

  return (
    <div className="page-stack">
      <PageHeader
        title="Skills"
        description="Discovery, runtime availability, and AdaptiveSkills health and amendment review."
        actions={
          <input
            className="compact-search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter skills"
          />
        }
      />

      <div className="metric-grid">
        <MetricCard
          label="Installed skills"
          value={String(skillsQuery.data?.skills.length || 0)}
          detail={`${skillsQuery.data?.disabled.length || 0} disabled`}
        />
        <MetricCard
          label="Observed skills"
          value={String(healthMetrics.length)}
          detail="from AdaptiveSkills observations"
        />
        <MetricCard
          label="Degraded skills"
          value={String(degradedSkillCount)}
          detail="current inspection window"
        />
        <MetricCard
          label="Staged amendments"
          value={String(stagedAmendments.length)}
          detail="awaiting human review"
        />
      </div>

      <div className="two-column-grid">
        <Panel title="Discovery">
          <KeyValueGrid>
            <KeyValueItem
              label="Extra dirs"
              value={
                skillsQuery.data?.extraDirs.length
                  ? skillsQuery.data.extraDirs.join(', ')
                  : 'none'
              }
            />
            <KeyValueItem
              label="Disabled skills"
              value={
                skillsQuery.data?.disabled.length
                  ? skillsQuery.data.disabled.join(', ')
                  : 'none'
              }
            />
          </KeyValueGrid>
        </Panel>

        <Panel
          title="AdaptiveSkills"
          subtitle={
            selectedMetrics
              ? `${selectedMetrics.skill_name} selected for history review`
              : 'Select a skill to review amendment history'
          }
          accent="warm"
        >
          {selectedMetrics ? (
            <KeyValueGrid>
              <KeyValueItem
                label="Status"
                value={selectedMetrics.degraded ? 'degraded' : 'healthy'}
              />
              <KeyValueItem
                label="Executions"
                value={selectedMetrics.total_executions}
              />
              <KeyValueItem
                label="Success rate"
                value={formatPercent(selectedMetrics.success_rate)}
              />
              <KeyValueItem
                label="Feedback"
                value={formatFeedbackCounts(selectedMetrics)}
              />
            </KeyValueGrid>
          ) : (
            <EmptyState>
              No AdaptiveSkills observations are available yet.
            </EmptyState>
          )}
        </Panel>
      </div>

      <Panel
        title="Installed skills"
        subtitle={`${filteredSkills.length} skill${filteredSkills.length === 1 ? '' : 's'} visible`}
      >
        {skillsQuery.isLoading ? (
          <EmptyState>Loading skill catalog...</EmptyState>
        ) : (
          <div className="table-shell">
            <table>
              <thead>
                <tr>
                  <th>Skill</th>
                  <th>Source</th>
                  <th>Runtime</th>
                  <th>Adaptive</th>
                  <th>Tags</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredSkills.map((skill) => {
                  const metrics = healthMetrics.find(
                    (entry) => entry.skill_name === skill.name,
                  );
                  return (
                    <tr key={skill.name}>
                      <td>
                        <Button
                          variant="link"
                          onClick={() => setSelectedSkillName(skill.name)}
                        >
                          {skill.name}
                        </Button>
                        <small>{skill.description}</small>
                      </td>
                      <td>{skill.source}</td>
                      <td>
                        <BooleanPill
                          value={skill.available}
                          trueLabel="ready"
                          falseLabel="missing"
                        />
                        {!skill.available ? (
                          <small>
                            {skill.missing.join(', ') || 'missing requirements'}
                          </small>
                        ) : null}
                      </td>
                      <td>
                        {metrics ? (
                          <>
                            <BooleanPill
                              value={!metrics.degraded}
                              trueLabel="healthy"
                              falseLabel="degraded"
                            />
                            <small>
                              {metrics.total_executions} runs ·{' '}
                              {formatFeedbackCounts(metrics)}
                            </small>
                          </>
                        ) : (
                          <small>no observations</small>
                        )}
                      </td>
                      <td>{skill.tags.join(', ') || 'none'}</td>
                      <td>
                        <BooleanToggle
                          value={skill.enabled}
                          ariaLabel={`${skill.name} status`}
                          disabled={toggleMutation.isPending}
                          trueLabel="active"
                          falseLabel="inactive"
                          onChange={(enabled) =>
                            toggleMutation.mutate({
                              name: skill.name,
                              enabled,
                            })
                          }
                        />
                      </td>
                    </tr>
                  );
                })}
                {filteredSkills.length === 0 ? (
                  <tr>
                    <td colSpan={6}>
                      <EmptyState>
                        No skills match this filter.
                      </EmptyState>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        )}
        {toggleMutation.isError ? (
          <Banner variant="error">
            {(toggleMutation.error as Error).message}
          </Banner>
        ) : null}
      </Panel>

      <div className="two-column-grid">
        <Panel
          title="Observed skill health"
          subtitle={`${filteredHealthMetrics.length} observed skill${filteredHealthMetrics.length === 1 ? '' : 's'} visible`}
        >
          {healthQuery.isLoading ? (
            <EmptyState>Loading AdaptiveSkills health...</EmptyState>
          ) : filteredHealthMetrics.length === 0 ? (
            <EmptyState>
              No observed skills match this filter.
            </EmptyState>
          ) : (
            <div className="table-shell">
              <table>
                <thead>
                  <tr>
                    <th>Skill</th>
                    <th>Status</th>
                    <th>Executions</th>
                    <th>Success</th>
                    <th>Tool breakage</th>
                    <th>Feedback</th>
                    <th>Reasons</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredHealthMetrics.map((metrics) => (
                    <tr key={metrics.skill_name}>
                      <td>
                        <Button
                          variant="link"
                          onClick={() =>
                            setSelectedSkillName(metrics.skill_name)
                          }
                        >
                          {metrics.skill_name}
                        </Button>
                        <small>
                          Window ending{' '}
                          {formatDateTime(metrics.window_ended_at)}
                        </small>
                      </td>
                      <td>
                        <BooleanPill
                          value={!metrics.degraded}
                          trueLabel="healthy"
                          falseLabel="degraded"
                        />
                      </td>
                      <td>{metrics.total_executions}</td>
                      <td>{formatPercent(metrics.success_rate)}</td>
                      <td>{formatPercent(metrics.tool_breakage_rate)}</td>
                      <td>{formatFeedbackCounts(metrics)}</td>
                      <td>
                        <small>
                          {metrics.degradation_reasons.join('; ') || 'healthy'}
                        </small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel
          title="Staged amendments"
          subtitle={`${stagedAmendments.length} waiting for review`}
          accent="warm"
        >
          {stagedAmendmentsQuery.isLoading ? (
            <EmptyState>Loading staged amendments...</EmptyState>
          ) : stagedAmendments.length === 0 ? (
            <EmptyState>
              No staged amendments are waiting for review.
            </EmptyState>
          ) : (
            <div className="list-stack selectable-list">
              {stagedAmendments.map((amendment) => (
                <div className="list-row" key={amendment.id}>
                  <div>
                    <Button
                      variant="link"
                      onClick={() => setSelectedSkillName(amendment.skill_name)}
                    >
                      {amendment.skill_name}
                    </Button>
                    <small>
                      {formatAmendmentStatus(amendment)} ·{' '}
                      {formatAmendmentTiming(amendment)} · guard{' '}
                      {amendment.guard_verdict}/{amendment.guard_findings_count}
                    </small>
                    <small>
                      {amendment.rationale || amendment.diff_summary}
                    </small>
                  </div>
                  <div className="skill-review-actions">
                    <Button
                      variant="ghost"
                      onClick={() => setSelectedSkillName(amendment.skill_name)}
                    >
                      History
                    </Button>
                    <Button
                      variant="primary"
                      disabled={reviewMutation.isPending}
                      onClick={() =>
                        reviewMutation.mutate({
                          action: 'apply',
                          skillName: amendment.skill_name,
                        })
                      }
                    >
                      Apply
                    </Button>
                    <Button
                      variant="danger"
                      disabled={reviewMutation.isPending}
                      onClick={() =>
                        reviewMutation.mutate({
                          action: 'reject',
                          skillName: amendment.skill_name,
                        })
                      }
                    >
                      Reject
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {reviewMutation.isError ? (
            <Banner variant="error">
              {(reviewMutation.error as Error).message}
            </Banner>
          ) : null}
        </Panel>
      </div>

      <Panel
        title={
          effectiveSelectedSkillName
            ? `Amendment history: ${effectiveSelectedSkillName}`
            : 'Amendment history'
        }
        subtitle="Full review trail for the selected skill"
      >
        {!effectiveSelectedSkillName ? (
          <EmptyState>
            Select a skill to inspect its amendment history.
          </EmptyState>
        ) : historyQuery.isLoading ? (
          <EmptyState>Loading amendment history...</EmptyState>
        ) : historyEntries.length === 0 ? (
          <EmptyState>
            No amendment history exists for this skill yet.
          </EmptyState>
        ) : (
          <div className="list-stack selectable-list">
            {historyEntries.map((amendment) => (
              <div className="list-row" key={amendment.id}>
                <div>
                  <strong>
                    {formatAmendmentStatus(amendment)} ·{' '}
                    {formatAmendmentTiming(amendment)}
                  </strong>
                  <small>
                    Guard {amendment.guard_verdict}/
                    {amendment.guard_findings_count} · runs since apply{' '}
                    {amendment.runs_since_apply}
                  </small>
                  <small>
                    {amendment.rationale || 'No rationale recorded.'}
                  </small>
                  <small>
                    {amendment.diff_summary || 'No diff summary recorded.'}
                  </small>
                </div>
                <span
                  className={
                    amendment.status === 'applied'
                      ? 'list-status list-status-success'
                      : amendment.status === 'rejected'
                        ? 'list-status list-status-danger'
                        : 'list-status'
                  }
                >
                  {amendment.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
