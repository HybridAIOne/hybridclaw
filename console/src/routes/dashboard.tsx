import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import {
  fetchOverview,
  fetchStatistics,
  fetchTunnelConfig,
  reconnectTunnel,
  saveTunnelConfig,
  stopTunnel,
} from '../api/client';
import type {
  AdminOverview,
  AdminTunnelConfig,
  AdminTunnelProvider,
  AdminTunnelStatus,
} from '../api/types';
import { useAuth } from '../auth';
import { Button } from '../components/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/card';
import { Input } from '../components/input';
import { NativeSelect, NativeSelectOption } from '../components/native-select';
import { ProviderHealthPanel } from '../components/provider-health';
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
import {
  formatDateTime,
  formatRelativeTime,
  formatUptime,
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

const TUNNEL_PROVIDER_META = {
  manual: {
    label: 'Manual URL',
    managed: false,
    usesConfiguredPublicUrl: true,
    requiresPublicUrl: false,
  },
  ngrok: {
    label: 'ngrok',
    managed: true,
    usesConfiguredPublicUrl: false,
    requiresPublicUrl: false,
  },
  tailscale: {
    label: 'Tailscale Funnel',
    managed: true,
    usesConfiguredPublicUrl: false,
    requiresPublicUrl: false,
  },
  cloudflare: {
    label: 'Cloudflare Tunnel',
    managed: true,
    usesConfiguredPublicUrl: true,
    requiresPublicUrl: true,
  },
  ssh: {
    label: 'SSH tunnel',
    managed: false,
    usesConfiguredPublicUrl: true,
    requiresPublicUrl: false,
  },
} as const satisfies Record<
  AdminTunnelProvider,
  {
    label: string;
    managed: boolean;
    usesConfiguredPublicUrl: boolean;
    requiresPublicUrl: boolean;
  }
>;

const TUNNEL_PROVIDER_OPTIONS = Object.entries(TUNNEL_PROVIDER_META).map(
  ([value, meta]) => ({
    value: value as AdminTunnelProvider,
    label: meta.label,
  }),
);

type TunnelProvider = AdminTunnelProvider;

interface TunnelConfigDraft {
  provider: TunnelProvider;
  publicUrl: string;
}

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

function isTunnelProvider(value: string): value is TunnelProvider {
  return Object.hasOwn(TUNNEL_PROVIDER_META, value);
}

function normalizeTunnelProvider(
  value: string | null | undefined,
): TunnelProvider {
  if (value && isTunnelProvider(value)) return value;
  return 'manual';
}

function normalizeTunnelUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    return new URL(trimmed).toString().replace(/\/$/, '');
  } catch {
    return trimmed;
  }
}

function tunnelDraftFromConfig(config: AdminTunnelConfig): TunnelConfigDraft {
  return {
    provider: normalizeTunnelProvider(config.provider),
    publicUrl: config.publicUrl || '',
  };
}

function isManagedTunnelProvider(provider: TunnelProvider): boolean {
  return TUNNEL_PROVIDER_META[provider].managed;
}

function usesConfiguredPublicUrl(provider: TunnelProvider): boolean {
  return TUNNEL_PROVIDER_META[provider].usesConfiguredPublicUrl;
}

function isSameTunnelDraft(left: TunnelConfigDraft, right: TunnelConfigDraft) {
  return (
    left.provider === right.provider &&
    normalizeTunnelUrl(left.publicUrl) === normalizeTunnelUrl(right.publicUrl)
  );
}

function getTunnelUrlValidation(draft: TunnelConfigDraft): string | null {
  const meta = TUNNEL_PROVIDER_META[draft.provider];
  if (!meta.usesConfiguredPublicUrl) return null;
  const publicUrl = draft.publicUrl.trim();
  if (!publicUrl) {
    return meta.requiresPublicUrl
      ? 'Public URL is required for Cloudflare Tunnel.'
      : null;
  }

  let parsed: URL;
  try {
    parsed = new URL(publicUrl);
  } catch {
    return 'Public URL must be a valid URL.';
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'Public URL must use http:// or https://.';
  }
  return null;
}

function usesHttpTunnelUrl(draft: TunnelConfigDraft): boolean {
  if (!usesConfiguredPublicUrl(draft.provider)) return false;
  try {
    return new URL(draft.publicUrl.trim()).protocol === 'http:';
  } catch {
    return false;
  }
}

function TunnelStatusPanel(props: {
  tunnel: AdminTunnelStatus;
  configLoaded: boolean;
  configPending: boolean;
  configDraft: TunnelConfigDraft;
  savedConfigDraft: TunnelConfigDraft | null;
  configSavePending: boolean;
  configStartPending: boolean;
  configSaveError: string | null;
  reconnectPending: boolean;
  reconnectError: string | null;
  stopPending: boolean;
  stopError: string | null;
  onConfigDraftChange: (draft: TunnelConfigDraft) => void;
  onSaveConfig: () => void;
  onSaveConfigAndStart: () => void;
  onReconnect: () => void;
  onStop: () => void;
}) {
  const { tunnel } = props;
  const publicUrl = tunnel.publicUrl || 'not configured';
  const reconnectDisabled =
    props.reconnectPending || props.stopPending || !tunnel.reconnectSupported;
  const normalizedTunnelError = tunnel.lastError?.trim() || null;
  const normalizedReconnectError = props.reconnectError?.trim() || null;
  const normalizedStopError = props.stopError?.trim() || null;
  const distinctReconnectError =
    props.reconnectError && normalizedReconnectError !== normalizedTunnelError
      ? props.reconnectError
      : null;
  const distinctStopError =
    props.stopError &&
    normalizedStopError !== normalizedTunnelError &&
    normalizedStopError !== normalizedReconnectError
      ? props.stopError
      : null;
  const configDirty = props.savedConfigDraft
    ? !isSameTunnelDraft(props.configDraft, props.savedConfigDraft)
    : false;
  const providerUsesPublicUrl = usesConfiguredPublicUrl(
    props.configDraft.provider,
  );
  const providerCanStart = isManagedTunnelProvider(props.configDraft.provider);
  const publicUrlError = getTunnelUrlValidation(props.configDraft);
  const publicUrlWarning = usesHttpTunnelUrl(props.configDraft)
    ? 'Public tunnel URL uses HTTP. HTTPS is recommended.'
    : null;
  const configBusy =
    !props.configLoaded || props.configPending || props.configSavePending;
  const saveDisabled = configBusy || !configDirty || Boolean(publicUrlError);
  const currentProvider = normalizeTunnelProvider(tunnel.provider);
  const tunnelMatchesDraftProvider =
    currentProvider === props.configDraft.provider;
  const tunnelRunning =
    !configDirty && tunnelMatchesDraftProvider && tunnel.state === 'up';
  const tunnelStarting =
    !configDirty &&
    tunnelMatchesDraftProvider &&
    (tunnel.state === 'starting' || tunnel.state === 'reconnecting');
  const startPending = props.configStartPending || props.reconnectPending;
  const tunnelActionLoading =
    startPending || props.stopPending || tunnelStarting;
  const tunnelActionLabel = props.stopPending
    ? 'Stopping'
    : startPending || tunnelStarting
      ? 'Starting'
      : tunnelRunning
        ? 'Stop'
        : configDirty
          ? 'Save & start'
          : 'Start';
  const startDisabled =
    configBusy ||
    props.reconnectPending ||
    props.stopPending ||
    Boolean(publicUrlError);
  const stopDisabled =
    configBusy || props.reconnectPending || props.stopPending;
  const tunnelActionDisabled = tunnelRunning ? stopDisabled : startDisabled;
  const tunnelActionVariant =
    tunnelRunning || props.stopPending ? 'danger' : 'default';
  const handleTunnelAction = tunnelRunning
    ? props.onStop
    : props.onSaveConfigAndStart;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Public tunnel</CardTitle>
      </CardHeader>
      <CardContent>
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
        <div className="tunnel-config-grid">
          <label className="tunnel-control">
            <span>Provider</span>
            <NativeSelect
              value={props.configDraft.provider}
              disabled={props.configPending || props.configSavePending}
              onChange={(event) =>
                props.onConfigDraftChange({
                  ...props.configDraft,
                  provider: normalizeTunnelProvider(event.target.value),
                })
              }
            >
              {TUNNEL_PROVIDER_OPTIONS.map((option) => (
                <NativeSelectOption key={option.value} value={option.value}>
                  {option.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          {providerUsesPublicUrl ? (
            <label className="tunnel-control">
              <span>Public URL</span>
              <Input
                value={props.configDraft.publicUrl}
                placeholder="https://example.ngrok-free.dev"
                disabled={props.configPending || props.configSavePending}
                onChange={(event) =>
                  props.onConfigDraftChange({
                    ...props.configDraft,
                    publicUrl: event.target.value,
                  })
                }
              />
            </label>
          ) : null}
          <div className="tunnel-config-actions">
            <Button
              type="button"
              variant="outline"
              onClick={props.onSaveConfig}
              loading={props.configSavePending && !props.configStartPending}
              disabled={saveDisabled}
            >
              Save
            </Button>
            {providerCanStart ? (
              <Button
                type="button"
                variant={tunnelActionVariant}
                onClick={handleTunnelAction}
                loading={tunnelActionLoading}
                disabled={tunnelActionDisabled}
              >
                {tunnelActionLoading ? (
                  <span className="button-spinner" aria-hidden="true" />
                ) : null}
                {tunnelActionLabel}
              </Button>
            ) : null}
          </div>
        </div>
        {publicUrlError ? (
          <p className="supporting-text tunnel-error">{publicUrlError}</p>
        ) : null}
        {publicUrlWarning ? (
          <p className="supporting-text tunnel-warning">{publicUrlWarning}</p>
        ) : null}
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
          <p className="supporting-text tunnel-error">
            {distinctReconnectError}
          </p>
        ) : null}
        {distinctStopError ? (
          <p className="supporting-text tunnel-error">{distinctStopError}</p>
        ) : null}
        {props.configSaveError ? (
          <p className="supporting-text tunnel-error">
            {props.configSaveError}
          </p>
        ) : null}
      </CardContent>
    </Card>
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
  const tunnelConfigQuery = useQuery({
    queryKey: ['tunnel-config', auth.token],
    queryFn: () => fetchTunnelConfig(auth.token),
    staleTime: 30_000,
  });
  const savedTunnelDraft = useMemo(
    () =>
      tunnelConfigQuery.data
        ? tunnelDraftFromConfig(tunnelConfigQuery.data.config)
        : null,
    [tunnelConfigQuery.data],
  );
  const [tunnelConfigDraft, setTunnelConfigDraft] =
    useState<TunnelConfigDraft | null>(null);
  const reconnectMutation = useMutation({
    mutationFn: () => reconnectTunnel(auth.token),
    onSuccess: (tunnel) => {
      queryClient.setQueryData<AdminOverview>(
        ['overview', auth.token],
        (current) => (current ? { ...current, tunnel } : current),
      );
    },
  });
  const stopMutation = useMutation({
    mutationFn: () => stopTunnel(auth.token),
    onSuccess: (tunnel) => {
      queryClient.setQueryData<AdminOverview>(
        ['overview', auth.token],
        (current) => (current ? { ...current, tunnel } : current),
      );
    },
  });
  const saveTunnelConfigMutation = useMutation({
    mutationFn: async (variables: {
      draft: TunnelConfigDraft;
      start: boolean;
    }) => {
      const payload = await saveTunnelConfig(auth.token, {
        provider: variables.draft.provider,
        publicUrl: usesConfiguredPublicUrl(variables.draft.provider)
          ? normalizeTunnelUrl(variables.draft.publicUrl)
          : '',
      });
      const tunnel =
        variables.start && isManagedTunnelProvider(variables.draft.provider)
          ? await reconnectTunnel(auth.token)
          : null;
      return { payload, tunnel };
    },
    onSuccess: ({ payload, tunnel }) => {
      queryClient.setQueryData(['tunnel-config', auth.token], payload);
      setTunnelConfigDraft(null);
      if (tunnel) {
        queryClient.setQueryData<AdminOverview>(
          ['overview', auth.token],
          (current) => (current ? { ...current, tunnel } : current),
        );
        return;
      }
      void queryClient.invalidateQueries({
        queryKey: ['overview', auth.token],
      });
    },
  });

  const overview = live.overview || overviewQuery.data;
  const status = live.status || overview?.status || auth.gatewayStatus;
  const tunnelStartPending =
    saveTunnelConfigMutation.isPending &&
    saveTunnelConfigMutation.variables?.start === true;
  const effectiveTunnelConfigDraft = tunnelConfigDraft ??
    savedTunnelDraft ?? {
      provider: normalizeTunnelProvider(overview?.tunnel.provider),
      publicUrl: overview?.tunnel.publicUrl ?? '',
    };
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

      <div className="two-column-grid">
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

        <ProviderHealthPanel
          title="Backend health"
          entries={backendEntries}
          onLogin={() => void navigate({ to: '/admin/config' })}
        />
      </div>

      <TunnelStatusPanel
        tunnel={overview.tunnel}
        configLoaded={Boolean(tunnelConfigQuery.data)}
        configPending={tunnelConfigQuery.isLoading}
        configDraft={effectiveTunnelConfigDraft}
        savedConfigDraft={savedTunnelDraft}
        configSavePending={saveTunnelConfigMutation.isPending}
        configStartPending={tunnelStartPending}
        configSaveError={
          saveTunnelConfigMutation.isError
            ? getErrorMessage(saveTunnelConfigMutation.error)
            : null
        }
        reconnectPending={reconnectMutation.isPending}
        reconnectError={
          reconnectMutation.isError
            ? getErrorMessage(reconnectMutation.error)
            : null
        }
        stopPending={stopMutation.isPending}
        stopError={
          stopMutation.isError ? getErrorMessage(stopMutation.error) : null
        }
        onConfigDraftChange={setTunnelConfigDraft}
        onSaveConfig={() =>
          saveTunnelConfigMutation.mutate({
            draft: effectiveTunnelConfigDraft,
            start: false,
          })
        }
        onSaveConfigAndStart={() =>
          saveTunnelConfigMutation.mutate({
            draft: effectiveTunnelConfigDraft,
            start: true,
          })
        }
        onReconnect={() => reconnectMutation.mutate()}
        onStop={() => stopMutation.mutate()}
      />

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
