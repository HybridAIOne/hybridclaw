import { useQuery } from '@tanstack/react-query';
import { fetchCoworkerScoreboard } from '../api/client';
import type { AdminCoworkerScoreboardEntry } from '../api/types';
import { useAuth } from '../auth';
import {
  MetricCard,
  PageHeader,
  Panel,
  SortableHeader,
  useSortableRows,
} from '../components/ui';
import { formatRelativeTime } from '../lib/format';
import { compareNumber, compareText } from '../lib/sort';

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatBestAt(coworker: AdminCoworkerScoreboardEntry): string {
  const bestSkill = coworker.best_skills[0];
  if (!bestSkill) return 'No observed skill runs';
  return `${bestSkill.skill_name} (${bestSkill.score}/100)`;
}

type CoworkerSortKey =
  | 'coworker'
  | 'score'
  | 'runs'
  | 'success'
  | 'skill'
  | 'recent';

const COWORKER_SORTERS: Record<
  CoworkerSortKey,
  (
    left: AdminCoworkerScoreboardEntry,
    right: AdminCoworkerScoreboardEntry,
  ) => number
> = {
  coworker: (left, right) =>
    compareText(left.display_name, right.display_name) ||
    compareText(left.coworker_id, right.coworker_id),
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

const COWORKER_DEFAULT_DIRECTIONS = {
  score: 'desc',
  runs: 'desc',
  success: 'desc',
  recent: 'desc',
} as const;

export function CoworkersPage() {
  const auth = useAuth();
  const scoreboardQuery = useQuery({
    queryKey: ['coworker-scoreboard', auth.token],
    queryFn: () => fetchCoworkerScoreboard(auth.token),
  });
  const coworkers = scoreboardQuery.data?.coworkers || [];
  const observedSkills = new Set(
    coworkers.flatMap((coworker) =>
      coworker.best_skills.map((score) => score.skill_name),
    ),
  );
  const topCoworker = [...coworkers].sort(
    (left, right) => right.avg_score - left.avg_score,
  )[0];
  const { sortedRows, sortState, toggleSort } = useSortableRows<
    AdminCoworkerScoreboardEntry,
    CoworkerSortKey
  >(coworkers, {
    initialSort: { key: 'score', direction: 'desc' },
    sorters: COWORKER_SORTERS,
    defaultDirections: COWORKER_DEFAULT_DIRECTIONS,
  });

  return (
    <div className="page-stack">
      <PageHeader
        title="Coworkers"
        description="Review coworker skill track records, top strengths, and generated CV paths."
      />

      <div className="metric-grid">
        <MetricCard
          label="Observed coworkers"
          value={String(coworkers.length)}
          detail="with recorded skill runs"
        />
        <MetricCard
          label="Observed skills"
          value={String(observedSkills.size)}
          detail="across coworker runs"
        />
        <MetricCard
          label="Best average score"
          value={topCoworker ? `${topCoworker.avg_score}/100` : '0/100'}
          detail={topCoworker?.display_name || 'No runs yet'}
        />
        <MetricCard
          label="Total runs"
          value={String(
            coworkers.reduce(
              (total, coworker) => total + coworker.total_executions,
              0,
            ),
          )}
          detail="skill executions"
        />
      </div>

      <Panel
        title="Coworker scoreboard"
        subtitle={`${sortedRows.length} coworker${sortedRows.length === 1 ? '' : 's'} visible`}
      >
        {scoreboardQuery.isLoading ? (
          <div className="empty-state">Loading coworker scoreboard...</div>
        ) : sortedRows.length === 0 ? (
          <div className="empty-state">
            No coworker skill runs recorded yet.
          </div>
        ) : (
          <div className="table-shell">
            <table>
              <thead>
                <tr>
                  <SortableHeader
                    label="Coworker"
                    sortKey="coworker"
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
                {sortedRows.map((coworker) => (
                  <tr key={coworker.coworker_id}>
                    <td>
                      <strong>{coworker.display_name}</strong>
                      <div className="supporting-text">
                        {coworker.coworker_id}
                      </div>
                    </td>
                    <td>{coworker.avg_score}/100</td>
                    <td>{coworker.total_executions}</td>
                    <td>{formatPercent(coworker.success_rate)}</td>
                    <td>
                      <strong>{formatBestAt(coworker)}</strong>
                    </td>
                    <td>
                      {coworker.last_observed_at
                        ? formatRelativeTime(coworker.last_observed_at)
                        : 'No recent runs'}
                    </td>
                    <td>
                      <a
                        href={`/admin/agents?agent=${encodeURIComponent(coworker.coworker_id)}&file=CV.md`}
                      >
                        CV.md
                      </a>
                      <div className="supporting-text">
                        <code>{coworker.cv_path}</code>
                      </div>
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
