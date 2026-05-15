import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdminBrowserPoolHealthResponse,
  AdminConfig,
  AdminConfigResponse,
} from '../api/types';
import { ToastProvider } from '../components/toast';
import { ConfigPage } from './config';

const fetchConfigMock = vi.fn<() => Promise<AdminConfigResponse>>();
const fetchBrowserPoolHealthMock =
  vi.fn<() => Promise<AdminBrowserPoolHealthResponse>>();
const saveConfigMock = vi.fn();
const startBrowserPoolMock = vi.fn();
const useAuthMock = vi.fn();

vi.mock('../api/client', () => ({
  fetchBrowserPoolHealth: () => fetchBrowserPoolHealthMock(),
  fetchConfig: () => fetchConfigMock(),
  saveConfig: (...args: unknown[]) => saveConfigMock(...args),
  startBrowserPool: (...args: unknown[]) => startBrowserPoolMock(...args),
}));

vi.mock('../auth', () => ({
  useAuth: () => useAuthMock(),
}));

function makeConfig(): AdminConfig {
  return {
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
      gatewayBaseUrl: '',
      gatewayApiToken: '',
      dbPath: '',
      logLevel: 'info',
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
}

function renderConfigPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <ConfigPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useAuthMock.mockReturnValue({ token: 'admin-token' });
  const config = makeConfig();
  fetchConfigMock.mockResolvedValue({
    path: '/tmp/config.json',
    config,
  });
  fetchBrowserPoolHealthMock.mockResolvedValue({
    ok: false,
    status: 'offline',
    endpointUrl: 'http://127.0.0.1:8787',
    nodeCount: 0,
    healthyNodeCount: 0,
    message:
      'Managed browser pool health check failed at http://127.0.0.1:8787: fetch failed',
  });
  saveConfigMock.mockResolvedValue({
    path: '/tmp/config.json',
    config,
  });
  startBrowserPoolMock.mockResolvedValue({
    ok: true,
    status: 'started',
    endpointUrl: 'http://127.0.0.1:8787',
    pid: 1234,
    message: 'Managed browser pool healthy: 1/1 nodes available.',
    poolTokenRefId: 'MANAGED_BROWSER_POOL_TOKEN',
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('ConfigPage', () => {
  it('edits managed cloud browser config from the form view', async () => {
    renderConfigPage();

    const provider = await screen.findByDisplayValue('local');
    fireEvent.change(provider, { target: { value: 'managed-cloud' } });
    expect(await screen.findByText(/fetch failed/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start Docker pool' }));
    await waitFor(() => expect(startBrowserPoolMock).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByDisplayValue('MANAGED_BROWSER_POOL_TOKEN'),
    ).toBeTruthy();
    fireEvent.change(screen.getByDisplayValue('http://127.0.0.1:8787'), {
      target: { value: 'https://browser.example' },
    });
    fireEvent.change(
      screen.getByPlaceholderText('MANAGED_BROWSER_POOL_TOKEN'),
      {
        target: { value: 'MANAGED_BROWSER_POOL_TOKEN' },
      },
    );
    fireEvent.change(screen.getByDisplayValue('0'), {
      target: { value: '0.0005' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save config' }));

    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledTimes(1));
    expect(saveConfigMock).toHaveBeenCalledWith(
      'admin-token',
      expect.objectContaining({
        browser: expect.objectContaining({
          provider: 'managed-cloud',
          managedCloud: expect.objectContaining({
            endpointUrl: 'https://browser.example',
            poolTokenRef: {
              source: 'store',
              id: 'MANAGED_BROWSER_POOL_TOKEN',
            },
            pricing: {
              actionUsd: 0.0005,
            },
          }),
        }),
      }),
    );
  });
});
