import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import {
  getRuntimeConfig,
  type RuntimeDeploymentTunnelProvider,
} from '../config/runtime-config.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import { createNgrokTunnelProvider } from '../tunnel/ngrok-tunnel-provider.js';
import type {
  TunnelProvider,
  TunnelState,
  TunnelStatus,
} from '../tunnel/tunnel-provider.js';
import type {
  GatewayAdminTunnelHealth,
  GatewayAdminTunnelStatus,
} from './gateway-types.js';

const TUNNEL_AUDIT_SESSION_ID = 'system:tunnel';

let managedProvider: TunnelProvider | null = null;
let managedProviderKey: string | null = null;

function normalizePublicUrl(value: string | null | undefined): string | null {
  const normalized = value?.trim() || '';
  return normalized || null;
}

function tunnelHealthForState(state: TunnelState): GatewayAdminTunnelHealth {
  if (state === 'up') return 'healthy';
  if (state === 'starting' || state === 'reconnecting') return 'reconnecting';
  return 'down';
}

function managedProviderKeyFor(params: {
  provider: RuntimeDeploymentTunnelProvider | undefined;
  healthCheckIntervalMs: number;
}): string {
  return `${params.provider || 'none'}:${params.healthCheckIntervalMs}`;
}

function getManagedTunnelProvider(): TunnelProvider | null {
  const config = getRuntimeConfig();
  const provider = config.deployment.tunnel.provider;
  if (provider !== 'ngrok') {
    managedProvider = null;
    managedProviderKey = null;
    return null;
  }

  const key = managedProviderKeyFor({
    provider,
    healthCheckIntervalMs: config.deployment.tunnel.health_check_interval_ms,
  });
  if (!managedProvider || managedProviderKey !== key) {
    managedProvider = createNgrokTunnelProvider({
      healthCheckIntervalMs: config.deployment.tunnel.health_check_interval_ms,
    });
    managedProviderKey = key;
  }
  return managedProvider;
}

function mapTunnelStatus(params: {
  provider: RuntimeDeploymentTunnelProvider | undefined;
  configuredPublicUrl: string | null;
  managedStatus: TunnelStatus | null;
}): GatewayAdminTunnelStatus {
  const publicUrl =
    normalizePublicUrl(params.managedStatus?.public_url) ||
    params.configuredPublicUrl;
  const state = params.managedStatus?.state ?? (publicUrl ? 'up' : 'down');

  return {
    provider: params.provider ?? null,
    publicUrl,
    state,
    health: tunnelHealthForState(state),
    running: params.managedStatus?.running ?? Boolean(publicUrl),
    reconnectSupported: params.provider === 'ngrok',
    lastError: params.managedStatus?.last_error ?? null,
    lastCheckedAt: params.managedStatus?.last_checked_at ?? null,
    nextReconnectAt: params.managedStatus?.next_reconnect_at ?? null,
    reconnectAttempt: params.managedStatus?.reconnect_attempt ?? 0,
  };
}

export function getGatewayAdminTunnelStatus(): GatewayAdminTunnelStatus {
  const config = getRuntimeConfig();
  const provider = config.deployment.tunnel.provider;
  const managedStatus = getManagedTunnelProvider()?.status() ?? null;

  return mapTunnelStatus({
    provider,
    configuredPublicUrl: normalizePublicUrl(config.deployment.public_url),
    managedStatus,
  });
}

export async function reconnectGatewayAdminTunnel(): Promise<GatewayAdminTunnelStatus> {
  const before = getGatewayAdminTunnelStatus();
  recordAuditEvent({
    sessionId: TUNNEL_AUDIT_SESSION_ID,
    runId: makeAuditRunId('tunnel-admin'),
    event: {
      type: 'tunnel.manual_reconnect',
      provider: before.provider ?? 'none',
      public_url: before.publicUrl,
      state: before.state,
    },
  });

  const provider = getManagedTunnelProvider();
  if (!provider || before.provider !== 'ngrok') {
    throw new GatewayRequestError(
      409,
      'Manual reconnect is only supported for ngrok tunnels.',
    );
  }

  await provider.stop();
  await provider.start();
  return getGatewayAdminTunnelStatus();
}

export function resetGatewayAdminTunnelForTests(): void {
  managedProvider = null;
  managedProviderKey = null;
}
