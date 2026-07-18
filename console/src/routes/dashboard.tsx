import { useQuery } from '@tanstack/react-query';
import { fetchOverview, fetchStatistics } from '../api/client';
import { useAuth } from '../auth';
import { Card, CardContent, CardHeader, CardTitle } from '../components/card';
import {
  MetricCard,
  PageHeader,
  SortableHeader,
  useSortableRows,
} from '../components/ui';
import { UsageRollup } from '../components/usage-rollup';
import { useLiveConnectionToasts } from '../hooks/use-live-connection-toasts';
import { useLiveEvents } from '../hooks/use-live-events';
import { getErrorMessage } from '../lib/error-message';
import { formatRelativeTime, formatUptime } from '../lib/format';
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

const TREND_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  // Trend buckets come from the statistics API as UTC `YYYY-MM-DD`. Format
  // them in UTC so a west-of-UTC user doesn't see the bucket shift one day
  // earlier (midnight UTC is the previous local day).
  timeZone: 'UTC',
});

function formatTrendDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  if (!year || !month || !day) return isoDate;
  return TREND_DATE_FORMAT.format(new Date(Date.UTC(year, month - 1, day)));
}

export function DashboardPage() {
  const auth = useAuth();
  const live = useLiveEvents(auth.token);
  useLiveConnectionToasts(live.connection);
  const overviewQuery = useQuery({
    queryKey: ['overview', auth.token],
    queryFn: () => fetchOverview(auth.token),
    refetchInterval: 30_000,
  });
  const usageTrendQuery = useQuery({
    queryKey: ['usage-trend', auth.token, 30],
    queryFn: () => fetchStatistics(auth.token, 30),
    staleTime: 60_000,
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

  return (
    <div className="page-stack">
      <PageHeader />

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

      <Card variant="muted">
        <CardHeader>
          <CardTitle>Usage rollup</CardTitle>
        </CardHeader>
        <CardContent>
          <UsageRollup
            usage={overview.usage}
            trend={usageTrendQuery.data?.trend ?? null}
            formatTrendDate={formatTrendDate}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent sessions</CardTitle>
        </CardHeader>
        <CardContent>
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
        </CardContent>
      </Card>
    </div>
  );
}
