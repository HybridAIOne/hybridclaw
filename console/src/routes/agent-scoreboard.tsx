import { useQuery } from '@tanstack/react-query';
import { fetchAgentScoreboard } from '../api/client';
import type { AdminAgentScoreboardEntry } from '../api/types';
import { useAuth } from '../auth';
import {
  MetricCard,
  PageHeader,
  Panel,
  SortableHeader,
  useSortableRows,
} from '../components/ui';
import { formatPercent, formatRelativeTime } from '../lib/format';
import { compareNumber, compareText } from '../lib/sort';

function formatBestAt(agent: AdminAgentScoreboardEntry): string {
  const bestSkill = agent.best_skills[0];
  if (!bestSkill) return 'No observed skill runs';
  return `${bestSkill.skill_name} (${bestSkill.score}/100)`;
}

type AgentSortKey = 'agent' | 'score' | 'runs' | 'success' | 'skill' | 'recent';

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
  success: (left, right) =>
    compareNumber(left.success_rate, right.success_rate) ||
    compareText(left.display_name, right.display_name),
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
  success: 'desc',
  recent: 'desc',
} as const;

export function AgentsPage() {
  const auth = useAuth();
  const scoreboardQuery = useQuery({
    queryKey: ['agent-scoreboard', auth.token],
    queryFn: () => fetchAgentScoreboard(auth.token),
  });
  const agents = scoreboardQuery.data?.agents || [];
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
      <PageHeader
        title="Agents"
        description="Review agent skill track records, top strengths, and generated CV paths."
      />

      <div className="metric-grid">
        <MetricCard
          label="Observed agents"
          value={String(agents.length)}
          detail="with recorded skill runs"
        />
        <MetricCard
          label="Observed skills"
          value={String(observedSkillCount)}
          detail="across agent runs"
        />
        <MetricCard
          label="Best average score"
          value={topAgent ? `${topAgent.avg_score}/100` : '0/100'}
          detail={topAgent?.display_name || 'No runs yet'}
        />
        <MetricCard
          label="Total runs"
          value={String(
            agents.reduce((total, agent) => total + agent.total_executions, 0),
          )}
          detail="skill executions"
        />
      </div>

      <Panel
        title="Agent scoreboard"
        subtitle={`${sortedRows.length} agent${sortedRows.length === 1 ? '' : 's'} visible`}
      >
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
                    label="Success"
                    sortKey="success"
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
                    <td>{formatPercent(agent.success_rate)}</td>
                    <td>
                      <strong>{formatBestAt(agent)}</strong>
                    </td>
                    <td>
                      {agent.last_observed_at
                        ? formatRelativeTime(agent.last_observed_at)
                        : 'No recent runs'}
                    </td>
                    <td>
                      <a
                        href={`/admin/agents?agent=${encodeURIComponent(agent.agent_id)}&file=CV.md`}
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
      </Panel>
    </div>
  );
}
