import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdminConfig,
  AdminConfigResponse,
  AdminLogsResponse,
} from '../api/types';
import { renderWithProviders } from '../test-utils';
import { LogsPage } from './logs';

const fetchAdminLogsMock = vi.fn<() => Promise<AdminLogsResponse>>();
const fetchConfigMock = vi.fn<() => Promise<AdminConfigResponse>>();
const reloadGatewayMock = vi.fn();
const saveConfigMock = vi.fn();
const useAuthMock = vi.fn();

vi.mock('../api/client', () => ({
  fetchAdminLogs: () => fetchAdminLogsMock(),
  fetchConfig: () => fetchConfigMock(),
  reloadGateway: (...args: unknown[]) => reloadGatewayMock(...args),
  saveConfig: (...args: unknown[]) => saveConfigMock(...args),
}));

vi.mock('../auth', () => ({
  useAuth: () => useAuthMock(),
}));

function makeConfig(overrides: Partial<AdminConfig> = {}): AdminConfig {
  const base = {
    version: 1,
    security: {
      trustModelAccepted: false,
      trustModelAcceptedAt: '',
      trustModelVersion: '',
      trustModelAcceptedBy: '',
      confidentialRedactionEnabled: false,
    },
    hybridai: {
      baseUrl: 'https://hybridai.one',
      defaultModel: 'gpt-5',
      defaultChatbotId: '',
      maxTokens: 4096,
      enableRag: true,
      models: ['gpt-5'],
    },
    channelInstructions: {
      discord: '',
      discord_webhook: '',
      msteams: '',
      slack: '',
      slack_webhook: '',
      signal: '',
      telegram: '',
      threema: '',
      voice: '',
      whatsapp: '',
      email: '',
      imessage: '',
    },
    container: {
      sandboxMode: 'container',
      image: '',
      memory: '2g',
      memorySwap: '2g',
      cpus: '2',
      network: 'none',
      timeoutMs: 300000,
      binds: [],
      additionalMounts: '',
      maxOutputBytes: 100000,
      maxConcurrent: 2,
      persistBashState: false,
    },
    ops: {
      healthHost: '127.0.0.1',
      healthPort: 9090,
      webApiToken: '',
      gatewayBaseUrl: 'http://127.0.0.1:9090',
      gatewayInternalBaseUrl: 'http://127.0.0.1:9090',
      gatewayApiToken: '',
      dbPath: '',
      logLevel: 'info',
      logRequests: false,
      debugModelResponses: false,
    },
    browser: {
      provider: 'local',
      local: {
        profileDir: '',
        headed: false,
      },
      camofox: {
        profileDir: '',
        headed: false,
      },
      managedCloud: {
        endpointUrl: 'http://127.0.0.1:8787',
        poolTokenRef: undefined,
        defaultTenantId: '',
        pricing: {
          actionUsd: 0,
        },
      },
      browserUseCloud: {
        apiKeyRef: undefined,
        projectId: '',
        profileId: '',
        region: '',
        keepAlive: false,
        pricing: {
          browserUsdPerMinute: 0,
          actionUsd: 0,
        },
      },
    },
  } as unknown as AdminConfig;

  return {
    ...base,
    ...overrides,
    ops: {
      ...base.ops,
      ...(overrides.ops ?? {}),
    },
  };
}

function makeLogs(): AdminLogsResponse {
  return {
    files: [
      {
        id: 'gateway',
        label: 'Gateway',
        path: '/tmp/gateway.log',
        exists: true,
        readable: true,
        sizeBytes: 12,
        mtime: '2026-06-16T12:00:00.000Z',
        description:
          'Gateway process stdout/stderr and structured runtime logs.',
        error: null,
      },
    ],
    selected: {
      fileId: 'gateway',
      content: 'gateway log\n',
      tailBytes: 12,
      truncated: false,
    },
    logging: {
      configuredLevel: 'info',
      effectiveLevel: 'info',
      forcedLevel: null,
      logRequests: {
        configured: false,
        envEnabled: false,
        effective: false,
      },
      debugModelResponses: {
        configured: false,
        envEnabled: false,
        effective: false,
      },
    },
  };
}

function renderLogsPage(): void {
  renderWithProviders(<LogsPage />);
}

function restorePrototypeProperty(
  prototype: object,
  property: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(prototype, property, descriptor);
    return;
  }
  Reflect.deleteProperty(prototype, property);
}

describe('LogsPage', () => {
  beforeEach(() => {
    useAuthMock.mockReturnValue({ token: 'admin-token' });
    fetchAdminLogsMock.mockResolvedValue(makeLogs());
    const config = makeConfig();
    fetchConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config,
    });
    saveConfigMock.mockImplementation((_token: string, next: AdminConfig) =>
      Promise.resolve({
        path: '/tmp/config.json',
        config: next,
      }),
    );
    reloadGatewayMock.mockResolvedValue({
      status: 'ok',
      message: 'Gateway reloaded.',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('saves debug logging mode to config and reloads the gateway', async () => {
    renderLogsPage();

    expect(await screen.findByText('Current mode: on')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Debug' }));

    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledTimes(1));
    expect(saveConfigMock).toHaveBeenCalledWith(
      'admin-token',
      expect.objectContaining({
        ops: expect.objectContaining({
          logLevel: 'debug',
          logRequests: true,
          debugModelResponses: true,
        }),
      }),
    );
    expect(reloadGatewayMock).toHaveBeenCalledWith('admin-token');
  });

  it('shows debug when the runtime logger is forced to debug', async () => {
    fetchAdminLogsMock.mockResolvedValue({
      ...makeLogs(),
      logging: {
        configuredLevel: 'info',
        effectiveLevel: 'debug',
        forcedLevel: 'debug',
        logRequests: {
          configured: false,
          envEnabled: false,
          effective: false,
        },
        debugModelResponses: {
          configured: false,
          envEnabled: false,
          effective: false,
        },
      },
    });

    renderLogsPage();

    const description = await screen.findByText(
      'Current mode: debug (forced by runtime)',
    );
    const loggingCard = description.closest('[data-slot="card"]');
    expect(loggingCard).toBeTruthy();
    await waitFor(() =>
      expect(
        within(loggingCard as HTMLElement)
          .getByRole('button', { name: 'Debug' })
          .getAttribute('aria-pressed'),
      ).toBe('true'),
    );
  });

  it('jumps to the end of the selected log after loading', async () => {
    const scrollTopSetter = vi.fn();
    const scrollTopDescriptor = Object.getOwnPropertyDescriptor(
      HTMLPreElement.prototype,
      'scrollTop',
    );
    const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
      HTMLPreElement.prototype,
      'scrollHeight',
    );
    Object.defineProperty(HTMLPreElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => 4096,
    });
    Object.defineProperty(HTMLPreElement.prototype, 'scrollTop', {
      configurable: true,
      get: () => 0,
      set: scrollTopSetter,
    });

    try {
      renderLogsPage();

      await screen.findByText('gateway log');
      await waitFor(() => expect(scrollTopSetter).toHaveBeenCalledWith(4096));
    } finally {
      restorePrototypeProperty(
        HTMLPreElement.prototype,
        'scrollTop',
        scrollTopDescriptor,
      );
      restorePrototypeProperty(
        HTMLPreElement.prototype,
        'scrollHeight',
        scrollHeightDescriptor,
      );
    }
  });

  it('saves off logging mode to config and reloads the gateway', async () => {
    const config = makeConfig({
      ops: {
        ...makeConfig().ops,
        logLevel: 'debug',
        logRequests: true,
        debugModelResponses: true,
      },
    });
    fetchConfigMock.mockResolvedValueOnce({
      path: '/tmp/config.json',
      config,
    });

    renderLogsPage();

    expect(await screen.findByText('Current mode: debug')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Off' }));

    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledTimes(1));
    expect(saveConfigMock).toHaveBeenCalledWith(
      'admin-token',
      expect.objectContaining({
        ops: expect.objectContaining({
          logLevel: 'silent',
          logRequests: false,
          debugModelResponses: false,
        }),
      }),
    );
    expect(reloadGatewayMock).toHaveBeenCalledWith('admin-token');
  });
});
