import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import {
  getRuntimeConfig,
  type RuntimeDeploymentTunnelProvider,
} from '../config/runtime-config.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import { createCloudflareTunnelProvider } from '../tunnel/cloudflare-tunnel-provider.js';
import { createNgrokTunnelProvider } from '../tunnel/ngrok-tunnel-provider.js';
import { createTailscaleTunnelProvider } from '../tunnel/tailscale-tunnel-provider.js';
import type {
  TunnelProvider,
  TunnelState,
  TunnelStatus,
} from '../tunnel/tunnel-provider.js';
import {
  DEFAULT_TUNNEL_AUDIT_SESSION_ID,
  errorMessage,
} from '../tunnel/tunnel-provider-utils.js';
import type {
  GatewayAdminTunnelHealth,
  GatewayAdminTunnelStatus,
} from './gateway-types.js';

let managedProvider: TunnelProvider | null = null;
let managedProviderKey: string | null = null;
let reconnectInFlight: Promise<GatewayAdminTunnelStatus> | null = null;

function normalizePublicUrl(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

function tunnelHealthForState(state: TunnelState): GatewayAdminTunnelHealth {
  if (state === 'up') return 'healthy';
  if (state === 'starting' || state === 'reconnecting') return 'reconnecting';
  return 'down';
}

function formatTunnelTargetAddr(host: string, port: number): string {
  const normalizedHost = host.trim() || '127.0.0.1';
  const displayHost = normalizedHost.includes(':')
    ? `[${normalizedHost.replace(/^\[|\]$/g, '')}]`
    : normalizedHost;
  return `${displayHost}:${port}`;
}

function managedProviderKeyFor(params: {
  addr: string;
  publicUrl: string | null;
  provider: RuntimeDeploymentTunnelProvider | undefined;
  healthCheckIntervalMs: number;
}): string {
  const healthKey =
    params.provider === 'ngrok' ||
    params.provider === 'tailscale' ||
    params.provider === 'cloudflare'
      ? `:${params.healthCheckIntervalMs}`
      : '';
  const publicUrlKey =
    params.provider === 'cloudflare' ? `:${params.publicUrl ?? ''}` : '';
  return `${params.provider || 'none'}:${params.addr}${healthKey}${publicUrlKey}`;
}

function stopStaleManagedProvider(provider: TunnelProvider): void {
  void provider.stop().catch((error) => {
    console.warn(
      '[tunnel] failed to stop stale managed tunnel provider.',
      errorMessage(error),
    );
  });
}

function getManagedTunnelProvider(): TunnelProvider | null {
  const config = getRuntimeConfig();
  const provider = config.deployment.tunnel.provider;
  if (
    provider !== 'ngrok' &&
    provider !== 'tailscale' &&
    provider !== 'cloudflare'
  ) {
    if (managedProvider) {
      stopStaleManagedProvider(managedProvider);
    }
    managedProvider = null;
    managedProviderKey = null;
    return null;
  }

  const addr = formatTunnelTargetAddr(
    config.ops.healthHost,
    config.ops.healthPort,
  );
  const key = managedProviderKeyFor({
    addr,
    publicUrl: normalizePublicUrl(config.deployment.public_url),
    provider,
    healthCheckIntervalMs: config.deployment.tunnel.health_check_interval_ms,
  });
  if (!managedProvider || managedProviderKey !== key) {
    if (managedProvider) {
      stopStaleManagedProvider(managedProvider);
    }
    if (provider === 'ngrok') {
      managedProvider = createNgrokTunnelProvider({
        addr,
        healthCheckIntervalMs:
          config.deployment.tunnel.health_check_interval_ms,
      });
    } else if (provider === 'tailscale') {
      managedProvider = createTailscaleTunnelProvider({
        addr,
        healthCheckIntervalMs:
          config.deployment.tunnel.health_check_interval_ms,
      });
    } else {
      managedProvider = createCloudflareTunnelProvider({
        addr,
        healthCheckIntervalMs:
          config.deployment.tunnel.health_check_interval_ms,
        publicUrl: config.deployment.public_url,
      });
    }
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
    reconnectSupported:
      params.provider === 'ngrok' ||
      params.provider === 'tailscale' ||
      params.provider === 'cloudflare',
    lastError: params.managedStatus?.last_error ?? null,
    lastCheckedAt: params.managedStatus?.last_checked_at ?? null,
    nextReconnectAt: params.managedStatus?.next_reconnect_at ?? null,
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
    sessionId: DEFAULT_TUNNEL_AUDIT_SESSION_ID,
    runId: makeAuditRunId('tunnel-admin'),
    event: {
      type: 'tunnel.manual_reconnect',
      provider: before.provider ?? 'none',
      public_url: before.publicUrl,
      state: before.state,
    },
  });

  const provider = getManagedTunnelProvider();
  if (!provider) {
    throw new GatewayRequestError(
      409,
      'Manual reconnect is only supported for managed tunnel providers.',
    );
  }

  if (reconnectInFlight) {
    return reconnectInFlight;
  }

  const operation = (async () => {
    await provider.stop();
    await provider.start();
    return getGatewayAdminTunnelStatus();
  })();
  reconnectInFlight = operation;
  try {
    return await operation;
  } finally {
    if (reconnectInFlight === operation) {
      reconnectInFlight = null;
    }
  }
}

export function resetGatewayAdminTunnelForTests(): void {
  managedProvider = null;
  managedProviderKey = null;
  reconnectInFlight = null;
}
