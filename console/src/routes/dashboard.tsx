import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { fetchOverview, fetchStatistics, reconnectTunnel } from '../api/client';
import type {
  AdminOverview,
  AdminStatisticsTrendDay,
  AdminTunnelStatus,
  AdminUsageSummary,
} from '../api/types';
import { useAuth } from '../auth';
import { ProviderHealthPanel } from '../components/provider-health';
import { Sparkline } from '../components/sparkline';
import {
  MetricCard,
  PageHeader,
  Panel,
  SortableHeader,
  useSortableRows,
} from '../components/ui';
import { useLiveConnectionToasts } from '../hooks/use-live-connection-toasts';
import { useLiveEvents } from '../hooks/use-live-events';
import { getErrorMessage } from '../lib/error-message';
import {
  formatCompactNumber,
  formatDateTime,
  formatRelativeTime,
  formatTokenBreakdown,
  formatUptime,
  formatUsd,
  pluralize,
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

const TREND_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
});

function formatTrendDate(isoDate: string): string {
  // Trend dates are UTC YYYY-MM-DD strings. Render them as a short
  // user-locale label without the trip through Date timezone shifting.
  const [year, month, day] = isoDate.split('-').map(Number);
  if (!year || !month || !day) return isoDate;
  return TREND_DATE_FORMAT.format(new Date(Date.UTC(year, month - 1, day)));
}

function tunnelStatusClass(health: AdminTunnelStatus['health']): string {
  if (health === 'healthy') return 'list-status list-status-success';
  if (health === 'reconnecting') return 'list-status list-status-warning';
  return 'list-status list-status-danger';
}

function tunnelStatusDotClass(health: AdminTunnelStatus['health']): string {
  if (health === 'healthy') return 'status-dot status-dot-success';
  if (health === 'reconnecting') return 'status-dot status-dot-warning';
  return 'status-dot status-dot-danger';
}

function TunnelStatusPanel(props: {
  tunnel: AdminTunnelStatus;
  reconnectPending: boolean;
  reconnectError: string | null;
  onReconnect: () => void;
}) {
  const { tunnel } = props;
  const publicUrl = tunnel.publicUrl || 'not configured';
  const reconnectDisabled =
    props.reconnectPending || !tunnel.reconnectSupported;
  const normalizedTunnelError = tunnel.lastError?.trim() || null;
  const normalizedReconnectError = props.reconnectError?.trim() || null;
  const distinctReconnectError =
    props.reconnectError && normalizedReconnectError !== normalizedTunnelError
      ? props.reconnectError
      : null;

  return (
    <Panel title="Public tunnel">
      <div className="tunnel-panel-grid">
        <div className="tunnel-url-stack">
          <span>Public URL</span>
          {tunnel.publicUrl ? (
            <a href={tunnel.publicUrl} target="_blank" rel="noreferrer">
              {publicUrl}
            </a>
          ) : (
            <strong>{publicUrl}</strong>
          )}
        </div>
        <div className="tunnel-action-stack">
          <button
            type="button"
            className="primary-button button-with-spinner"
            onClick={props.onReconnect}
            disabled={reconnectDisabled}
          >
            {props.reconnectPending ? (
              <span className="button-spinner" aria-hidden="true" />
            ) : null}
            {props.reconnectPending ? 'Reconnecting' : 'Reconnect'}
          </button>
        </div>
      </div>
      <div className="tunnel-detail-grid">
        <div className="tunnel-detail">
          <span>Provider</span>
          <strong>{tunnel.provider || 'none'}</strong>
        </div>
        <div className="tunnel-detail">
          <span>Status</span>
          <strong className={tunnelStatusClass(tunnel.health)}>
            <span className={tunnelStatusDotClass(tunnel.health)} />
            {tunnel.health}
          </strong>
        </div>
        <div className="tunnel-detail">
          <span>Last checked</span>
          <strong>{formatDateTime(tunnel.lastCheckedAt)}</strong>
        </div>
        <div className="tunnel-detail">
          <span>Next reconnect</span>
          <strong>{formatDateTime(tunnel.nextReconnectAt)}</strong>
        </div>
      </div>
      {tunnel.lastError ? (
        <p className="supporting-text tunnel-error">{tunnel.lastError}</p>
      ) : null}
      {distinctReconnectError ? (
        <p className="supporting-text tunnel-error">{distinctReconnectError}</p>
      ) : null}
    </Panel>
  );
}

function UsageMetric(props: { label: string; summary: AdminUsageSummary }) {
  const { summary } = props;
  const detailParts = [
    `${formatCompactNumber(summary.totalInputTokens ?? 0)} in`,
    `${formatCompactNumber(summary.totalOutputTokens ?? 0)} out`,
    pluralize(summary.callCount, 'call'),
    formatUsd(summary.totalCostUsd),
  ];
  return (
    <div className="usage-metric">
      <span className="usage-metric__label">{props.label}</span>
      <strong className="usage-metric__value">
        {formatCompactNumber(summary.totalTokens)}
        <span className="usage-metric__unit">tokens</span>
      </strong>
      <span className="usage-metric__detail">{detailParts.join(' · ')}</span>
    </div>
  );
}

function UsageRollupContent(props: {
  usage: AdminOverview['usage'];
  trend: AdminStatisticsTrendDay[] | null;
}) {
  const { daily, monthly, topModels } = props.usage;
  const hasMonthlyActivity = monthly.callCount > 0 || monthly.totalTokens > 0;
  const hasDailyActivity = daily.callCount > 0 || daily.totalTokens > 0;

  if (!hasMonthlyActivity && !hasDailyActivity) {
    return <p className="supporting-text">No usage has been recorded yet.</p>;
  }

  // The top-models list duplicates the monthly totals when only one model
  // is in use, so we only render it when it actually adds information.
  const showTopModels = topModels.length > 1;
  const trendPoints =
    props.trend?.map((day) => ({
      label: formatTrendDate(day.date),
      value: day.totalTokens,
    })) ?? [];
  const peak = trendPoints.reduce<{ label: string; value: number } | null>(
    (best, point) => (point.value > (best?.value ?? 0) ? point : best),
    null,
  );
  const peakLabel =
    peak && peak.value > 0
      ? `peak ${formatCompactNumber(peak.value)} on ${peak.label}`
      : undefined;
  const showTrend = trendPoints.length >= 2;

  return (
    <>
      <div className="usage-metrics">
        {hasDailyActivity ? (
          <UsageMetric label="Today" summary={daily} />
        ) : null}
        <UsageMetric label="Month to date" summary={monthly} />
      </div>
      {showTrend ? (
        <div className="usage-trend">
          <Sparkline
            points={trendPoints}
            height={44}
            ariaLabel="Tokens per day, last 30 days"
            formatValue={(value) =>
              `${formatCompactNumber(value)} ${value === 1 ? 'token' : 'tokens'}`
            }
            startLabel={`${trendPoints.length - 1}d ago`}
            endLabel="today"
            middleLabel={peakLabel}
          />
        </div>
      ) : null}
      {showTopModels ? (
        <div className="list-stack">
          {topModels.map((row) => (
            <div className="list-row" key={row.model}>
              <div>
                <strong>{row.model}</strong>
                <small>
                  {formatTokenBreakdown({
                    inputTokens: row.totalInputTokens ?? 0,
                    outputTokens: row.totalOutputTokens ?? 0,
                  })}{' '}
                  · {pluralize(row.callCount, 'call')} this month
                </small>
              </div>
              <span>{formatUsd(row.totalCostUsd)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

export function DashboardPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
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
  const reconnectMutation = useMutation({
    mutationFn: () => reconnectTunnel(auth.token),
    onSuccess: (tunnel) => {
      queryClient.setQueryData<AdminOverview>(
        ['overview', auth.token],
        (current) => (current ? { ...current, tunnel } : current),
      );
    },
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
      <PageHeader title="Dashboard" />

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
          <UsageRollupContent
            usage={overview.usage}
            trend={usageTrendQuery.data?.trend ?? null}
          />
        </Panel>

        <ProviderHealthPanel
          title="Backend health"
          entries={backendEntries}
          onLogin={() => void navigate({ to: '/admin/config' })}
        />
      </div>

      <TunnelStatusPanel
        tunnel={overview.tunnel}
        reconnectPending={reconnectMutation.isPending}
        reconnectError={
          reconnectMutation.isError
            ? getErrorMessage(reconnectMutation.error)
            : null
        }
        onReconnect={() => reconnectMutation.mutate()}
      />

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
