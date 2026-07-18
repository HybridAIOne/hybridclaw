import { useQuery } from '@tanstack/react-query';
import { fetchAgentScoreboard } from '../api/client';
import type { AdminAgentScoreboardEntry } from '../api/types';
import { useAuth } from '../auth';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/card';
import {
  MetricCard,
  PageHeader,
  SortableHeader,
  useSortableRows,
} from '../components/ui';
import { formatRelativeTime } from '../lib/format';
import { compareNumber, compareText } from '../lib/sort';

function formatBestAt(agent: AdminAgentScoreboardEntry): string {
  const bestSkill = agent.best_skills[0];
  if (!bestSkill) return 'No observed skill runs';
  return `${bestSkill.skill_name} (${bestSkill.score}/100)`;
}

type AgentSortKey =
  | 'agent'
  | 'score'
  | 'runs'
  | 'quality'
  | 'reliability'
  | 'timing'
  | 'anomalies'
  | 'skill'
  | 'recent';

const AGENT_SORTERS: Record<
  AgentSortKey,
  (left: AdminAgentScoreboardEntry, right: AdminAgentScoreboardEntry) => number
> = {
  agent: (left, right) =>
    compareText(left.display_name, right.display_name) ||
    compareText(left.agent_id, right.agent_id),
  score: (left, right) =>
    compareNumber(left.avg_score, right.avg_score) ||
    compareText(left.display_name, right.display_name),
  runs: (left, right) =>
    compareNumber(left.total_executions, right.total_executions) ||
    compareText(left.display_name, right.display_name),
  quality: (left, right) =>
    compareNumber(left.avg_quality_score, right.avg_quality_score) ||
    compareText(left.display_name, right.display_name),
  reliability: (left, right) =>
    compareNumber(left.avg_reliability_score, right.avg_reliability_score) ||
    compareText(left.display_name, right.display_name),
  timing: (left, right) =>
    compareNumber(left.avg_timing_score, right.avg_timing_score) ||
    compareText(left.display_name, right.display_name),
  anomalies: (left, right) =>
    compareNumber(
      left.weekly_anomalies_flagged,
      right.weekly_anomalies_flagged,
    ) || compareText(left.display_name, right.display_name),
  skill: (left, right) =>
    compareText(formatBestAt(left), formatBestAt(right)) ||
    compareText(left.display_name, right.display_name),
  recent: (left, right) =>
    compareText(left.last_observed_at || '', right.last_observed_at || '') ||
    compareText(left.display_name, right.display_name),
};

const AGENT_DEFAULT_DIRECTIONS = {
  score: 'desc',
  runs: 'desc',
  quality: 'desc',
  reliability: 'desc',
  timing: 'desc',
  anomalies: 'desc',
  recent: 'desc',
} as const;

export function AgentsPage(
  props: {
    selectedAgentId?: string;
    activeAgentIds?: ReadonlyArray<string>;
  } = {},
) {
  const auth = useAuth();
  const scoreboardQuery = useQuery({
    queryKey: ['agent-scoreboard', auth.token],
    queryFn: () => fetchAgentScoreboard(auth.token),
  });
  const activeAgentIds = props.activeAgentIds
    ? new Set(props.activeAgentIds)
    : null;
  const agents = (scoreboardQuery.data?.agents || []).filter(
    (agent) =>
      (!activeAgentIds || activeAgentIds.has(agent.agent_id)) &&
      (!props.selectedAgentId || agent.agent_id === props.selectedAgentId),
  );
  const observedSkillCount = scoreboardQuery.data?.observed_skill_count ?? 0;
  const topAgent = [...agents].sort(
    (left, right) => right.avg_score - left.avg_score,
  )[0];
  const { sortedRows, sortState, toggleSort } = useSortableRows<
    AdminAgentScoreboardEntry,
    AgentSortKey
  >(agents, {
    initialSort: { key: 'score', direction: 'desc' },
    sorters: AGENT_SORTERS,
    defaultDirections: AGENT_DEFAULT_DIRECTIONS,
  });

  return (
    <div className="page-stack">
      <PageHeader description="Review agent skill track records, top strengths, and generated CV paths." />

      <div className="metric-grid">
        <MetricCard
          label="Observed agents"
          value={String(agents.length)}
          detail="with recorded skill runs"
          loading={!scoreboardQuery.data}
        />
        <MetricCard
          label="Observed skills"
          value={String(observedSkillCount)}
          detail="across agent runs"
          loading={!scoreboardQuery.data}
        />
        <MetricCard
          label="Best average score"
          value={topAgent ? `${topAgent.avg_score}/100` : '0/100'}
          detail={topAgent?.display_name || 'No runs yet'}
          loading={!scoreboardQuery.data}
        />
        <MetricCard
          label="Total runs"
          value={String(
            agents.reduce((total, agent) => total + agent.total_executions, 0),
          )}
          detail="skill executions"
          loading={!scoreboardQuery.data}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Agent scoreboard</CardTitle>
          <CardDescription>
            {`${sortedRows.length} agent${sortedRows.length === 1 ? '' : 's'} visible`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {scoreboardQuery.isLoading ? (
            <div className="empty-state">Loading agent scoreboard...</div>
          ) : sortedRows.length === 0 ? (
            <div className="empty-state">No agent skill runs recorded yet.</div>
          ) : (
            <div className="table-shell">
              <table>
                <thead>
                  <tr>
                    <SortableHeader
                      label="Agent"
                      sortKey="agent"
                      sortState={sortState}
                      onToggle={toggleSort}
                    />
                    <SortableHeader
                      label="Score"
                      sortKey="score"
                      sortState={sortState}
                      onToggle={toggleSort}
                    />
                    <SortableHeader
                      label="Runs"
                      sortKey="runs"
                      sortState={sortState}
                      onToggle={toggleSort}
                    />
                    <SortableHeader
                      label="Quality"
                      sortKey="quality"
                      sortState={sortState}
                      onToggle={toggleSort}
                    />
                    <SortableHeader
                      label="Reliability"
                      sortKey="reliability"
                      sortState={sortState}
                      onToggle={toggleSort}
                    />
                    <SortableHeader
                      label="Timing"
                      sortKey="timing"
                      sortState={sortState}
                      onToggle={toggleSort}
                    />
                    <SortableHeader
                      label="Best at"
                      sortKey="skill"
                      sortState={sortState}
                      onToggle={toggleSort}
                    />
                    <SortableHeader
                      label="Anomalies"
                      sortKey="anomalies"
                      sortState={sortState}
                      onToggle={toggleSort}
                    />
                    <SortableHeader
                      label="Recent"
                      sortKey="recent"
                      sortState={sortState}
                      onToggle={toggleSort}
                    />
                    <th>CV</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((agent) => (
                    <tr key={agent.agent_id}>
                      <td>
                        <strong>{agent.display_name}</strong>
                        <div className="supporting-text">{agent.agent_id}</div>
                      </td>
                      <td>{agent.avg_score}/100</td>
                      <td>{agent.total_executions}</td>
                      <td>{agent.avg_quality_score}/100</td>
                      <td>{agent.avg_reliability_score}/100</td>
                      <td>{agent.avg_timing_score}/100</td>
                      <td>
                        <strong>{formatBestAt(agent)}</strong>
                        {agent.best_skills[0] ? (
                          <div className="supporting-text">
                            Q {agent.best_skills[0].quality_score} · R{' '}
                            {agent.best_skills[0].reliability_score} · T{' '}
                            {agent.best_skills[0].timing_score}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        {agent.weekly_anomalies_flagged}
                        <div className="supporting-text">
                          {agent.weekly_anomalies_confirmed_normal} confirmed
                          normal
                        </div>
                      </td>
                      <td>
                        {agent.last_observed_at
                          ? formatRelativeTime(agent.last_observed_at)
                          : 'No recent runs'}
                      </td>
                      <td>
                        <a
                          href={`/admin/agents?tab=files&agent=${encodeURIComponent(agent.agent_id)}&file=CV.md`}
                        >
                          CV.md
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
