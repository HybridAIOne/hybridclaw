import { afterEach, expect, test, vi } from 'vitest';
import type { RuntimeConfig } from '../src/config/runtime-config.js';
import type {
  TunnelProvider,
  TunnelStatus,
} from '../src/tunnel/tunnel-provider.js';

function makeRuntimeConfig(
  deployment: RuntimeConfig['deployment'],
): RuntimeConfig {
  return {
    deployment,
  } as RuntimeConfig;
}

const downStatus: TunnelStatus = {
  running: false,
  public_url: null,
  state: 'down',
  last_error: null,
  last_checked_at: null,
  next_reconnect_at: null,
  reconnect_attempt: 0,
};

async function importService(options: {
  config: RuntimeConfig;
  provider?: TunnelProvider;
}) {
  vi.resetModules();

  const recordAuditEvent = vi.fn();
  const makeAuditRunId = vi.fn(() => 'tunnel-admin-run');
  const createNgrokTunnelProvider = vi.fn(() => {
    if (!options.provider) {
      throw new Error('unexpected provider creation');
    }
    return options.provider;
  });

  vi.doMock('../src/config/runtime-config.js', () => ({
    getRuntimeConfig: () => options.config,
  }));
  vi.doMock('../src/audit/audit-events.js', () => ({
    makeAuditRunId,
    recordAuditEvent,
  }));
  vi.doMock('../src/tunnel/ngrok-tunnel-provider.js', () => ({
    createNgrokTunnelProvider,
  }));

  const service = await import('../src/gateway/gateway-tunnel-service.js');
  service.resetGatewayAdminTunnelForTests();
  return {
    ...service,
    createNgrokTunnelProvider,
    makeAuditRunId,
    recordAuditEvent,
  };
}

afterEach(() => {
  vi.doUnmock('../src/config/runtime-config.js');
  vi.doUnmock('../src/audit/audit-events.js');
  vi.doUnmock('../src/tunnel/ngrok-tunnel-provider.js');
  vi.resetModules();
});

test('admin tunnel status reports configured manual public URL as healthy', async () => {
  const service = await importService({
    config: makeRuntimeConfig({
      mode: 'local',
      public_url: 'https://bot.example.test',
      tunnel: {
        provider: 'manual',
        health_check_interval_ms: 30_000,
      },
    }),
  });

  expect(service.getGatewayAdminTunnelStatus()).toEqual({
    provider: 'manual',
    publicUrl: 'https://bot.example.test',
    state: 'up',
    health: 'healthy',
    running: true,
    reconnectSupported: false,
    lastError: null,
    lastCheckedAt: null,
    nextReconnectAt: null,
    reconnectAttempt: 0,
  });
  expect(service.createNgrokTunnelProvider).not.toHaveBeenCalled();
});

test('admin tunnel reconnect audits the action and restarts ngrok', async () => {
  let status: TunnelStatus = {
    ...downStatus,
    running: true,
    public_url: 'https://old.example.test',
    state: 'up',
  };
  const provider: TunnelProvider = {
    status: vi.fn(() => status),
    stop: vi.fn(async () => {
      status = { ...downStatus };
    }),
    start: vi.fn(async () => {
      status = {
        ...downStatus,
        running: true,
        public_url: 'https://new.example.test',
        state: 'up',
      };
      return { public_url: 'https://new.example.test' };
    }),
  };
  const service = await importService({
    config: makeRuntimeConfig({
      mode: 'local',
      public_url: '',
      tunnel: {
        provider: 'ngrok',
        health_check_interval_ms: 45_000,
      },
    }),
    provider,
  });

  await expect(service.reconnectGatewayAdminTunnel()).resolves.toMatchObject({
    provider: 'ngrok',
    publicUrl: 'https://new.example.test',
    health: 'healthy',
  });

  expect(service.createNgrokTunnelProvider).toHaveBeenCalledWith({
    healthCheckIntervalMs: 45_000,
  });
  expect(provider.stop).toHaveBeenCalledTimes(1);
  expect(provider.start).toHaveBeenCalledTimes(1);
  expect(service.recordAuditEvent).toHaveBeenCalledWith({
    sessionId: 'system:tunnel',
    runId: 'tunnel-admin-run',
    event: {
      type: 'tunnel.manual_reconnect',
      provider: 'ngrok',
      public_url: 'https://old.example.test',
      state: 'up',
    },
  });
});

test('unsupported tunnel reconnect is still audited before returning conflict', async () => {
  const service = await importService({
    config: makeRuntimeConfig({
      mode: 'local',
      public_url: '',
      tunnel: {
        provider: 'manual',
        health_check_interval_ms: 30_000,
      },
    }),
  });

  await expect(service.reconnectGatewayAdminTunnel()).rejects.toMatchObject({
    statusCode: 409,
  });
  expect(service.recordAuditEvent).toHaveBeenCalledWith({
    sessionId: 'system:tunnel',
    runId: 'tunnel-admin-run',
    event: {
      type: 'tunnel.manual_reconnect',
      provider: 'manual',
      public_url: null,
      state: 'down',
    },
  });
});
