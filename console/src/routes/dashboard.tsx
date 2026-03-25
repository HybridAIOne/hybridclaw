import { useQuery } from '@tanstack/react-query';
import { fetchOverview } from '../api/client';
import { useAuth } from '../auth';
import {
  EmptyState,
  ListRow,
  MetricCard,
  PageHeader,
  Panel,
} from '../components/ui';
import { useLiveEvents } from '../hooks/use-live-events';
import {
  formatCompactNumber,
  formatRelativeTime,
  formatTokenBreakdown,
  formatUptime,
  formatUsd,
} from '../lib/format';

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

  if (overviewQuery.isLoading && !overview) {
    return <EmptyState>Loading overview...</EmptyState>;
  }

  if (overviewQuery.isError && !overview) {
    return (
      <EmptyState variant="error">
        {(overviewQuery.error as Error).message}
      </EmptyState>
    );
  }

  if (!overview || !status) {
    return <EmptyState>Gateway overview unavailable.</EmptyState>;
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
            {live.connection === 'open'
              ? `live updates ${live.lastEventAt ? formatRelativeTime(new Date(live.lastEventAt).toISOString()) : ''}`.trim()
              : 'polling fallback'}
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
                <ListRow
                  key={row.model}
                  title={row.model}
                  meta={
                    <>
                      {formatTokenBreakdown({
                        inputTokens: row.totalInputTokens ?? 0,
                        outputTokens: row.totalOutputTokens ?? 0,
                      })}{' '}
                      · {row.callCount} calls this month
                    </>
                  }
                  status={formatUsd(row.totalCostUsd)}
                />
              ))
            )}
          </div>
        </Panel>

        <Panel title="Backend health">
          <div className="list-stack">
            {backendEntries.map(([name, backend]) => (
              <ListRow
                key={name}
                title={name}
                meta={
                  backend.detail ||
                  (backend.reachable
                    ? `${backend.latencyMs ?? 0}ms`
                    : backend.error || 'unreachable')
                }
                status={`${backend.modelCount ?? 0} models`}
              />
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
                <th>Session</th>
                <th>Model</th>
                <th>Messages</th>
                <th>Tasks</th>
                <th>Last active</th>
              </tr>
            </thead>
            <tbody>
              {overview.recentSessions.map((session) => (
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
