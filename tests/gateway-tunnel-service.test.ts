import { afterEach, expect, test, vi } from 'vitest';
import type { RuntimeConfig } from '../src/config/runtime-config.js';
import type {
  TunnelProvider,
  TunnelStatus,
} from '../src/tunnel/tunnel-provider.js';

function makeRuntimeConfig(
  deployment: RuntimeConfig['deployment'],
  options: { healthHost?: string; healthPort?: number } = {},
): RuntimeConfig {
  return {
    deployment,
    ops: {
      healthHost: options.healthHost ?? '127.0.0.1',
      healthPort: options.healthPort ?? 9090,
    },
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
  providers?: TunnelProvider[];
}) {
  vi.resetModules();

  const recordAuditEvent = vi.fn();
  const makeAuditRunId = vi.fn(() => 'tunnel-admin-run');
  const providers = options.providers
    ? [...options.providers]
    : options.provider
      ? [options.provider]
      : [];
  const createNgrokTunnelProvider = vi.fn(() => {
    const provider = providers.shift();
    if (!provider) {
      throw new Error('unexpected provider creation');
    }
    return provider;
  });
  const createTailscaleTunnelProvider = vi.fn(() => {
    const provider = providers.shift();
    if (!provider) {
      throw new Error('unexpected provider creation');
    }
    return provider;
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
  vi.doMock('../src/tunnel/tailscale-tunnel-provider.js', () => ({
    createTailscaleTunnelProvider,
  }));

  const service = await import('../src/gateway/gateway-tunnel-service.js');
  service.resetGatewayAdminTunnelForTests();
  return {
    ...service,
    createNgrokTunnelProvider,
    createTailscaleTunnelProvider,
    makeAuditRunId,
    recordAuditEvent,
  };
}

afterEach(() => {
  vi.doUnmock('../src/config/runtime-config.js');
  vi.doUnmock('../src/audit/audit-events.js');
  vi.doUnmock('../src/tunnel/ngrok-tunnel-provider.js');
  vi.doUnmock('../src/tunnel/tailscale-tunnel-provider.js');
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
    reconnectSupported: false,
    lastError: null,
    lastCheckedAt: null,
    nextReconnectAt: null,
  });
  expect(service.createNgrokTunnelProvider).not.toHaveBeenCalled();
  expect(service.createTailscaleTunnelProvider).not.toHaveBeenCalled();
});

test('admin tunnel status stops stale ngrok provider when config changes', async () => {
  const config = makeRuntimeConfig({
    mode: 'local',
    public_url: '',
    tunnel: {
      provider: 'ngrok',
      health_check_interval_ms: 30_000,
    },
  });
  const oldProvider: TunnelProvider = {
    status: vi.fn(() => downStatus),
    stop: vi.fn(async () => {}),
    start: vi.fn(async () => ({ public_url: 'https://old.example.test' })),
  };
  const newProvider: TunnelProvider = {
    status: vi.fn(() => downStatus),
    stop: vi.fn(async () => {}),
    start: vi.fn(async () => ({ public_url: 'https://new.example.test' })),
  };
  const service = await importService({
    config,
    providers: [oldProvider, newProvider],
  });

  service.getGatewayAdminTunnelStatus();
  config.deployment.tunnel.health_check_interval_ms = 45_000;
  service.getGatewayAdminTunnelStatus();

  expect(oldProvider.stop).toHaveBeenCalledTimes(1);
  expect(service.createNgrokTunnelProvider).toHaveBeenCalledTimes(2);

  config.deployment.tunnel.provider = 'manual';
  service.getGatewayAdminTunnelStatus();

  expect(newProvider.stop).toHaveBeenCalledTimes(1);
});

test('admin tunnel status creates a managed tailscale provider', async () => {
  const provider: TunnelProvider = {
    status: vi.fn(() => ({
      ...downStatus,
      running: true,
      public_url: 'https://gateway.example.ts.net',
      state: 'up',
    })),
    stop: vi.fn(async () => {}),
    start: vi.fn(async () => ({
      public_url: 'https://gateway.example.ts.net',
    })),
  };
  const service = await importService({
    config: makeRuntimeConfig(
      {
        mode: 'local',
        public_url: '',
        tunnel: {
          provider: 'tailscale',
          health_check_interval_ms: 60_000,
        },
      },
      { healthPort: 19_090 },
    ),
    provider,
  });

  expect(service.getGatewayAdminTunnelStatus()).toMatchObject({
    provider: 'tailscale',
    publicUrl: 'https://gateway.example.ts.net',
    health: 'healthy',
    reconnectSupported: true,
  });
  expect(service.createNgrokTunnelProvider).not.toHaveBeenCalled();
  expect(service.createTailscaleTunnelProvider).toHaveBeenCalledWith({
    addr: '127.0.0.1:19090',
    healthCheckIntervalMs: 60_000,
  });
});

test('admin tunnel status formats IPv6 tunnel target addresses', async () => {
  const provider: TunnelProvider = {
    status: vi.fn(() => downStatus),
    stop: vi.fn(async () => {}),
    start: vi.fn(async () => ({
      public_url: 'https://gateway.example.ts.net',
    })),
  };
  const service = await importService({
    config: makeRuntimeConfig(
      {
        mode: 'local',
        public_url: '',
        tunnel: {
          provider: 'tailscale',
          health_check_interval_ms: 30_000,
        },
      },
      { healthHost: '::1', healthPort: 9090 },
    ),
    provider,
  });

  service.getGatewayAdminTunnelStatus();

  expect(service.createTailscaleTunnelProvider).toHaveBeenCalledWith({
    addr: '[::1]:9090',
    healthCheckIntervalMs: 30_000,
  });
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
    addr: '127.0.0.1:9090',
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

test('admin tunnel reconnect serializes concurrent calls', async () => {
  let resolveStop!: () => void;
  const stopGate = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });
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
      await stopGate;
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

  const first = service.reconnectGatewayAdminTunnel();
  await vi.waitFor(() => expect(provider.stop).toHaveBeenCalledTimes(1));
  const second = service.reconnectGatewayAdminTunnel();

  expect(provider.stop).toHaveBeenCalledTimes(1);
  expect(provider.start).not.toHaveBeenCalled();

  resolveStop();
  await expect(Promise.all([first, second])).resolves.toEqual([
    expect.objectContaining({
      publicUrl: 'https://new.example.test',
      health: 'healthy',
    }),
    expect.objectContaining({
      publicUrl: 'https://new.example.test',
      health: 'healthy',
    }),
  ]);
  expect(provider.stop).toHaveBeenCalledTimes(1);
  expect(provider.start).toHaveBeenCalledTimes(1);
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
