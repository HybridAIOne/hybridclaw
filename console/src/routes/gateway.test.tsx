import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminAgent } from '../api/types';
import { renderWithProviders } from '../test-utils';
import { GatewayPage } from './gateway';

const fetchAdminAgentsMock = vi.fn<() => Promise<AdminAgent[]>>();
const reloadGatewayMock = vi.fn();
const updateAdminAgentMock = vi.fn();
const navigateMock = vi.fn();
const useAuthMock = vi.fn();
const useLiveEventsMock = vi.fn();

vi.mock('../api/client', () => ({
  fetchAdminAgents: () => fetchAdminAgentsMock(),
  reloadGateway: (...args: unknown[]) => reloadGatewayMock(...args),
  updateAdminAgent: (...args: unknown[]) => updateAdminAgentMock(...args),
}));

vi.mock('../auth', () => ({
  useAuth: () => useAuthMock(),
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>(
    '@tanstack/react-router',
  );
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

vi.mock('../hooks/use-live-events', () => ({
  useLiveEvents: (...args: unknown[]) => useLiveEventsMock(...args),
}));

function makeStatus(overrides: Record<string, unknown> = {}) {
  return {
    status: 'ok' as const,
    webAuthConfigured: true,
    pid: 1234,
    version: '0.9.7',
    imageTag: null,
    uptime: 120,
    sessions: 3,
    activeContainers: 1,
    defaultModel: 'gpt-5',
    ragDefault: true,
    timestamp: '2026-04-09T12:00:00.000Z',
    lifecycle: {
      restartSupported: true,
      restartReason: null,
    },
    providerHealth: {},
    scheduler: { jobs: [] },
    sandbox: {
      mode: 'container' as const,
      activeSessions: 1,
      warning: null,
    },
    codex: {
      authenticated: true,
      source: 'browser-pkce' as const,
      accountId: 'acct',
      expiresAt: null,
      reloginRequired: false,
    },
    observability: {
      enabled: false,
      running: false,
      paused: false,
      reason: null,
      streamKey: null,
      lastCursor: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
    },
    ...overrides,
  };
}

function makeAgent(overrides: Partial<AdminAgent> = {}): AdminAgent {
  return {
    id: 'main',
    name: 'Main Agent',
    model: 'gpt-5',
    skills: null,
    chatbotId: null,
    enableRag: true,
    role: null,
    reportsTo: null,
    delegatesTo: null,
    peers: null,
    workspace: null,
    workspacePath: '/tmp/main/workspace',
    markdownFiles: [],
    ...overrides,
  };
}

function renderGatewayPage(): void {
  renderWithProviders(<GatewayPage />);
}

describe('GatewayPage', () => {
  beforeEach(() => {
    fetchAdminAgentsMock.mockReset();
    reloadGatewayMock.mockReset();
    updateAdminAgentMock.mockReset();
    navigateMock.mockReset();
    useAuthMock.mockReset();
    useLiveEventsMock.mockReset();

    useAuthMock.mockReturnValue({
      token: 'test-token',
      gatewayStatus: makeStatus(),
    });
    useLiveEventsMock.mockReturnValue({
      connection: 'open',
      overview: null,
      status: null,
      lastEventAt: Date.now(),
    });
    fetchAdminAgentsMock.mockResolvedValue([makeAgent()]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('opens a reload confirmation dialog and calls the reload endpoint', async () => {
    reloadGatewayMock.mockResolvedValue({
      status: 'ok',
      message: 'Gateway reloaded.',
    });

    renderGatewayPage();
    fireEvent.click(screen.getByRole('button', { name: 'Reload Gateway' }));
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reload' }));

    await waitFor(() => {
      expect(reloadGatewayMock).toHaveBeenCalledWith('test-token');
    });
  });

  it('saves HybridAI proxy mode for the selected agent', async () => {
    const mainAgent = makeAgent({ chatbotId: 'local-chatbot' });
    const savedAgent = makeAgent({
      proxy: {
        kind: 'hybridai',
        baseUrl: 'https://hybridai.example.com',
        chatbotId: 'upstream-chatbot',
        apiKey: { source: 'store', id: 'HYBRIDAI_PROXY_KEY' },
        conversationScope: 'user',
      },
    });
    fetchAdminAgentsMock.mockResolvedValue([mainAgent]);
    updateAdminAgentMock.mockResolvedValue(savedAgent);

    renderGatewayPage();

    fireEvent.click(await screen.findByRole('switch', { name: 'Proxy mode' }));
    fireEvent.change(screen.getByLabelText('HybridAI base URL'), {
      target: { value: 'https://hybridai.example.com' },
    });
    fireEvent.change(screen.getByLabelText('Chatbot id'), {
      target: { value: 'upstream-chatbot' },
    });
    fireEvent.change(screen.getByLabelText('API key SecretRef id'), {
      target: { value: 'HYBRIDAI_PROXY_KEY' },
    });
    fireEvent.change(screen.getByLabelText('Conversation scope'), {
      target: { value: 'user' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Proxy Mode' }));

    await waitFor(() => {
      expect(updateAdminAgentMock).toHaveBeenCalledWith('test-token', 'main', {
        proxy: {
          kind: 'hybridai',
          baseUrl: 'https://hybridai.example.com',
          chatbotId: 'upstream-chatbot',
          apiKey: { source: 'store', id: 'HYBRIDAI_PROXY_KEY' },
          conversationScope: 'user',
        },
      });
    });
  });

  it('validates proxy base URL before saving', async () => {
    fetchAdminAgentsMock.mockResolvedValue([makeAgent()]);

    renderGatewayPage();

    fireEvent.click(await screen.findByRole('switch', { name: 'Proxy mode' }));
    fireEvent.change(screen.getByLabelText('HybridAI base URL'), {
      target: { value: 'http://hybridai.example.com' },
    });
    fireEvent.change(screen.getByLabelText('Chatbot id'), {
      target: { value: 'upstream-chatbot' },
    });
    fireEvent.change(screen.getByLabelText('API key SecretRef id'), {
      target: { value: 'HYBRIDAI_PROXY_KEY' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Proxy Mode' }));

    expect(
      await screen.findByText('HybridAI base URL must use HTTPS.'),
    ).toBeTruthy();
    expect(updateAdminAgentMock).not.toHaveBeenCalled();
  });
});
