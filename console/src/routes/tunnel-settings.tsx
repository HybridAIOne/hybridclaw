import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {
  fetchTunnelConfig,
  reconnectTunnel,
  saveTunnelConfig,
  stopTunnel,
} from '../api/client';
import type {
  AdminTunnelConfig,
  AdminTunnelConfigResponse,
  AdminTunnelProvider,
  AdminTunnelStatus,
} from '../api/types';
import { useAuth } from '../auth';
import { Button } from '../components/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/card';
import { Input } from '../components/input';
import { NativeSelect, NativeSelectOption } from '../components/native-select';
import { getErrorMessage } from '../lib/error-message';
import { formatDateTime } from '../lib/format';

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
  configDraft: TunnelConfigDraft;
  savedConfigDraft: TunnelConfigDraft;
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
  const configDirty = !isSameTunnelDraft(
    props.configDraft,
    props.savedConfigDraft,
  );
  const providerUsesPublicUrl = usesConfiguredPublicUrl(
    props.configDraft.provider,
  );
  const providerCanStart = isManagedTunnelProvider(props.configDraft.provider);
  const publicUrlError = getTunnelUrlValidation(props.configDraft);
  const publicUrlWarning = usesHttpTunnelUrl(props.configDraft)
    ? 'Public tunnel URL uses HTTP. HTTPS is recommended.'
    : null;
  const configBusy = props.configSavePending;
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
            <Button
              type="button"
              className="tunnel-action-button"
              onClick={props.onReconnect}
              loading={props.reconnectPending}
              disabled={reconnectDisabled}
            >
              {props.reconnectPending ? (
                <span className="button-spinner" aria-hidden="true" />
              ) : null}
              {props.reconnectPending ? 'Reconnecting' : 'Reconnect'}
            </Button>
          </div>
        </div>
        <div className="tunnel-config-grid">
          <label className="tunnel-control">
            <span>Provider</span>
            <NativeSelect
              value={props.configDraft.provider}
              disabled={props.configSavePending}
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
                disabled={props.configSavePending}
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
                className="tunnel-action-button"
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

export function TunnelSettings() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const tunnelConfigQuery = useQuery({
    queryKey: ['tunnel-config', auth.token],
    queryFn: () => fetchTunnelConfig(auth.token),
    refetchInterval: 30_000,
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

  const updateTunnelStatus = (tunnel: AdminTunnelStatus) => {
    queryClient.setQueryData<AdminTunnelConfigResponse>(
      ['tunnel-config', auth.token],
      (current) => (current ? { ...current, tunnel } : current),
    );
  };
  const reconnectMutation = useMutation({
    mutationFn: () => reconnectTunnel(auth.token),
    onSuccess: updateTunnelStatus,
  });
  const stopMutation = useMutation({
    mutationFn: () => stopTunnel(auth.token),
    onSuccess: updateTunnelStatus,
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
          : payload.tunnel;
      return { ...payload, tunnel };
    },
    onSuccess: (payload) => {
      queryClient.setQueryData(['tunnel-config', auth.token], payload);
      setTunnelConfigDraft(null);
    },
  });

  if (tunnelConfigQuery.isLoading) {
    return <div className="empty-state">Loading tunnel settings...</div>;
  }
  if (tunnelConfigQuery.isError) {
    return (
      <div className="empty-state error">
        {getErrorMessage(tunnelConfigQuery.error)}
      </div>
    );
  }
  if (!tunnelConfigQuery.data || !savedTunnelDraft) {
    return <div className="empty-state">Tunnel settings are unavailable.</div>;
  }

  const effectiveTunnelConfigDraft = tunnelConfigDraft ?? savedTunnelDraft;
  const tunnelStartPending =
    saveTunnelConfigMutation.isPending &&
    saveTunnelConfigMutation.variables?.start === true;

  return (
    <TunnelStatusPanel
      tunnel={tunnelConfigQuery.data.tunnel}
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
  );
}
