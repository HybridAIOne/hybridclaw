import { useQuery } from '@tanstack/react-query';
import { fetchOverview } from '../api/client';
import { useAuth } from '../auth';
import {
  MetricCard,
  PageHeader,
  Panel,
  SortableHeader,
  useSortableRows,
} from '../components/ui';
import { useLiveEvents } from '../hooks/use-live-events';
import { getErrorMessage } from '../lib/error-message';
import {
  formatCompactNumber,
  formatRelativeTime,
  formatTokenBreakdown,
  formatUptime,
  formatUsd,
} from '../lib/format';
import { compareDateTime, compareNumber, compareText } from '../lib/sort';

type RecentSession = Awaited<
  ReturnType<typeof fetchOverview>
>['recentSessions'][number];
type RecentSessionSortKey =
  | 'session'
  | 'model'
  | 'messages'
  | 'tasks'
  | 'lastActive';

const RECENT_SESSION_SORTERS: Record<
  RecentSessionSortKey,
  (left: RecentSession, right: RecentSession) => number
> = {
  session: (left, right) =>
    compareText(left.id, right.id) ||
    compareText(left.channelId, right.channelId),
  model: (left, right) =>
    compareText(left.effectiveModel, right.effectiveModel) ||
    compareText(left.id, right.id),
  messages: (left, right) =>
    compareNumber(left.messageCount, right.messageCount) ||
    compareText(left.id, right.id),
  tasks: (left, right) =>
    compareNumber(left.taskCount, right.taskCount) ||
    compareText(left.id, right.id),
  lastActive: (left, right) =>
    compareDateTime(left.lastActive, right.lastActive) ||
    compareText(left.id, right.id),
};

const RECENT_SESSION_DEFAULT_DIRECTIONS = {
  messages: 'desc',
  tasks: 'desc',
  lastActive: 'desc',
} as const;

export function DashboardPage() {
  const auth = useAuth();
  const live = useLiveEvents(auth.token);
  const overviewQuery = useQuery({
    queryKey: ['overview', auth.token],
    queryFn: () => fetchOverview(auth.token),
    refetchInterval: 30_000,
  });

  const overview = live.overview || overviewQuery.data;
  const status = live.status || overview?.status || auth.gatewayStatus;
  const {
    sortedRows: recentSessions,
    sortState,
    toggleSort,
  } = useSortableRows<RecentSession, RecentSessionSortKey>(
    overview?.recentSessions || [],
    {
      initialSort: {
        key: 'lastActive',
        direction: 'desc',
      },
      sorters: RECENT_SESSION_SORTERS,
      defaultDirections: RECENT_SESSION_DEFAULT_DIRECTIONS,
    },
  );

  if (overviewQuery.isLoading && !overview) {
    return <div className="empty-state">Loading overview...</div>;
  }

  if (overviewQuery.isError && !overview) {
    return (
      <div className="empty-state error">
        {getErrorMessage(overviewQuery.error)}
      </div>
    );
  }

  if (!overview || !status) {
    return <div className="empty-state">Gateway overview unavailable.</div>;
  }

  const schedulerJobs = status.scheduler?.jobs.length || 0;
  const backendEntries = Object.entries(
    status.providerHealth || status.localBackends || {},
  ) as Array<
    [
      string,
      {
        reachable: boolean;
        latencyMs?: number;
        error?: string;
        modelCount?: number;
        detail?: string;
      },
    ]
  >;

  return (
    <div className="page-stack">
      <PageHeader
        title="Dashboard"
        actions={
          <div className="status-pill">
            <span
              className={
                live.connection === 'open' ? 'status-dot live' : 'status-dot'
              }
            />
            {live.connection === 'open' ? 'connected' : 'polling fallback'}
          </div>
        }
      />

      <div className="metric-grid">
        <MetricCard
          label="Gateway sessions"
          value={String(status.sessions)}
          detail={`${overview.recentSessions.length} recent sessions surfaced`}
        />
        <MetricCard
          label="Active sandboxes"
          value={String(status.activeContainers)}
          detail={status.sandbox?.mode || 'container'}
        />
        <MetricCard
          label="Uptime"
          value={formatUptime(status.uptime)}
          detail={`version ${status.version}`}
        />
        <MetricCard
          label="Scheduler"
          value={String(schedulerJobs)}
          detail="registered jobs"
        />
      </div>

      <div className="two-column-grid">
        <Panel title="Usage rollup" accent="warm">
          <div className="usage-grid">
            <div className="usage-stack">
              <span>Daily</span>
              <strong>
                {formatCompactNumber(overview.usage.daily.totalTokens)}
              </strong>
              <small>
                {formatTokenBreakdown({
                  inputTokens: overview.usage.daily.totalInputTokens ?? 0,
                  outputTokens: overview.usage.daily.totalOutputTokens ?? 0,
                })}
              </small>
              <small>
                {formatUsd(overview.usage.daily.totalCostUsd)} across{' '}
                {overview.usage.daily.callCount} calls
              </small>
            </div>
            <div className="usage-stack">
              <span>Monthly</span>
              <strong>
                {formatCompactNumber(overview.usage.monthly.totalTokens)}
              </strong>
              <small>
                {formatTokenBreakdown({
                  inputTokens: overview.usage.monthly.totalInputTokens ?? 0,
                  outputTokens: overview.usage.monthly.totalOutputTokens ?? 0,
                })}
              </small>
              <small>
                {formatUsd(overview.usage.monthly.totalCostUsd)} across{' '}
                {overview.usage.monthly.callCount} calls
              </small>
            </div>
          </div>
          <div className="list-stack">
            {overview.usage.topModels.length === 0 ? (
              <p className="supporting-text">
                No model usage has been recorded yet.
              </p>
            ) : (
              overview.usage.topModels.map((row) => (
                <div className="list-row" key={row.model}>
                  <div>
                    <strong>{row.model}</strong>
                    <small>
                      {formatTokenBreakdown({
                        inputTokens: row.totalInputTokens ?? 0,
                        outputTokens: row.totalOutputTokens ?? 0,
                      })}{' '}
                      · {row.callCount} calls this month
                    </small>
                  </div>
                  <span>{formatUsd(row.totalCostUsd)}</span>
                </div>
              ))
            )}
          </div>
        </Panel>

        <Panel title="Backend health">
          <div className="list-stack">
            {backendEntries.map(([name, backend]) => (
              <div className="list-row" key={name}>
                <div>
                  <strong>{name}</strong>
                  <small>
                    {backend.detail ||
                      (backend.reachable
                        ? `${backend.latencyMs ?? 0}ms`
                        : backend.error || 'unreachable')}
                  </small>
                </div>
                <span>{backend.modelCount ?? 0} models</span>
              </div>
            ))}
            {backendEntries.length === 0 ? (
              <p className="supporting-text">
                No provider health data is available.
              </p>
            ) : null}
          </div>
        </Panel>
      </div>

      <Panel title="Recent sessions">
        <div className="table-shell">
          <table>
            <thead>
              <tr>
                <SortableHeader
                  label="Session"
                  sortKey="session"
                  sortState={sortState}
                  onToggle={toggleSort}
                />
                <SortableHeader
                  label="Model"
                  sortKey="model"
                  sortState={sortState}
                  onToggle={toggleSort}
                />
                <SortableHeader
                  label="Messages"
                  sortKey="messages"
                  sortState={sortState}
                  onToggle={toggleSort}
                />
                <SortableHeader
                  label="Tasks"
                  sortKey="tasks"
                  sortState={sortState}
                  onToggle={toggleSort}
                />
                <SortableHeader
                  label="Last active"
                  sortKey="lastActive"
                  sortState={sortState}
                  onToggle={toggleSort}
                />
              </tr>
            </thead>
            <tbody>
              {recentSessions.map((session) => (
                <tr key={session.id}>
                  <td>
                    <strong>{session.id}</strong>
                    <small>{session.channelId}</small>
                  </td>
                  <td>{session.effectiveModel}</td>
                  <td>{session.messageCount}</td>
                  <td>{session.taskCount}</td>
                  <td>{formatRelativeTime(session.lastActive)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
