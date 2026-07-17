import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminConnectorsResponse } from '../api/types';
import { renderWithProviders } from '../test-utils';
import { ConnectorsPage } from './connectors';

const fetchConnectorsMock = vi.fn<() => Promise<AdminConnectorsResponse>>();
const logoutConnectorMock = vi.fn();
const saveHybridAIConnectorKeyMock = vi.fn();
const startConnectorOAuthMock = vi.fn();
const testConnectorMock = vi.fn();
const useAuthMock = vi.fn();

vi.mock('../api/client', () => ({
  fetchConnectors: () => fetchConnectorsMock(),
  logoutConnector: (...args: unknown[]) => logoutConnectorMock(...args),
  saveHybridAIConnectorKey: (...args: unknown[]) =>
    saveHybridAIConnectorKeyMock(...args),
  startConnectorOAuth: (...args: unknown[]) => startConnectorOAuthMock(...args),
  testConnector: (...args: unknown[]) => testConnectorMock(...args),
}));

vi.mock('../auth', () => ({
  useAuth: () => useAuthMock(),
}));

function makeConnectorsResponse(): AdminConnectorsResponse {
  return {
    secretsPath: '/tmp/credentials.json',
    oauthRedirectUri: 'https://console.example/api/connectors/oauth/callback',
    connectors: [
      {
        id: 'hybridai',
        name: 'HybridAI',
        description:
          'Use HybridAI models, bots, and managed workspace features in HybridClaw.',
        state: 'not_connected',
        authKind: 'api-key',
        account: null,
        detail: 'Paste a HybridAI API key after signing in.',
        scopes: [],
        routesConfigured: true,
        clientConfigured: true,
        clientSecretConfigured: true,
        tenantId: null,
        loginUrl:
          'https://hybridai.one/login?context=hybridclaw&next=/admin_api_keys',
        adminConsentUrl: null,
        setupSecretNames: ['HYBRIDAI_API_KEY'],
      },
      {
        id: 'github',
        name: 'GitHub',
        description:
          'Work with repositories, pull requests, issues, and code from GitHub.',
        state: 'not_connected',
        authKind: 'oauth',
        account: null,
        detail: 'Managed by HybridAI connectors.',
        scopes: [],
        routesConfigured: true,
        clientConfigured: true,
        clientSecretConfigured: true,
        tenantId: null,
        loginUrl:
          'https://hybridai.one/admin_workspace/connectors?connect=github',
        adminConsentUrl: null,
        setupSecretNames: [],
      },
      {
        id: 'google',
        name: 'Google Workspace',
        description:
          'Bring Gmail, Calendar, Drive, Docs, Sheets, and contacts into your workflows.',
        state: 'needs_setup',
        authKind: 'oauth',
        account: null,
        detail:
          'OAuth client id and client secret are required before browser authorization.',
        scopes: ['https://www.googleapis.com/auth/calendar'],
        routesConfigured: false,
        clientConfigured: false,
        clientSecretConfigured: false,
        tenantId: null,
        loginUrl: null,
        adminConsentUrl: null,
        setupSecretNames: [
          'GOOGLE_ACCOUNT',
          'GOOGLE_OAUTH_CLIENT_ID',
          'GOOGLE_OAUTH_CLIENT_SECRET',
          'GOOGLE_OAUTH_SCOPES',
        ],
      },
      {
        id: 'microsoft365',
        name: 'Microsoft 365',
        description:
          'Connect work mail, calendars, files, SharePoint, OneDrive, and Teams.',
        state: 'not_connected',
        authKind: 'oauth',
        account: null,
        detail: 'Managed by HybridAI connectors.',
        scopes: [],
        routesConfigured: true,
        clientConfigured: true,
        clientSecretConfigured: true,
        tenantId: null,
        loginUrl:
          'https://hybridai.one/admin_workspace/connectors?connect=microsoft365',
        adminConsentUrl: null,
        setupSecretNames: [],
      },
    ],
  };
}

describe('ConnectorsPage', () => {
  beforeEach(() => {
    fetchConnectorsMock.mockReset();
    logoutConnectorMock.mockReset();
    saveHybridAIConnectorKeyMock.mockReset();
    startConnectorOAuthMock.mockReset();
    testConnectorMock.mockReset();
    useAuthMock.mockReset();
    useAuthMock.mockReturnValue({ token: 'admin-token' });
    fetchConnectorsMock.mockResolvedValue(makeConnectorsResponse());
  });

  it('renders prebuilt connector cards and setup state', async () => {
    renderWithProviders(<ConnectorsPage />);

    expect(await screen.findByText('HybridAI')).toBeTruthy();
    expect(screen.getByText('GitHub')).toBeTruthy();
    expect(screen.getByText('Google Workspace')).toBeTruthy();
    expect(screen.getByText('Microsoft 365')).toBeTruthy();
    expect(
      screen.queryByText('Prebuilt account and workspace integrations'),
    ).toBeNull();
    expect(screen.queryByText('GOOGLE_OAUTH_CLIENT_ID')).toBeNull();
    expect(screen.queryByText('Account')).toBeNull();
    expect(screen.queryByText('Auth')).toBeNull();
    expect(screen.queryByText('Routes')).toBeNull();
    expect(screen.queryByText(/hybridclaw auth login/u)).toBeNull();
    expect(screen.queryByText('HA')).toBeNull();
    expect(screen.queryByText('M365')).toBeNull();
  });

  it('starts GitHub through HybridClaw and opens the returned authorization URL', async () => {
    startConnectorOAuthMock.mockResolvedValue({
      provider: 'github',
      authorizationUrl:
        'https://github.com/apps/hybridai-test/installations/new',
      state: '',
      expiresAt: Date.now() + 600_000,
    });
    const openSpy = vi
      .spyOn(window, 'open')
      .mockReturnValue(null as unknown as Window);

    renderWithProviders(<ConnectorsPage />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Connect GitHub' }),
    );

    await waitFor(() =>
      expect(startConnectorOAuthMock).toHaveBeenCalledWith('admin-token', {
        provider: 'github',
      }),
    );
    expect(openSpy).toHaveBeenCalledWith(
      'https://github.com/apps/hybridai-test/installations/new',
      '_self',
    );

    openSpy.mockRestore();
  });

  it('starts Microsoft 365 through HybridClaw and opens the returned authorization URL', async () => {
    startConnectorOAuthMock.mockResolvedValue({
      provider: 'microsoft365',
      authorizationUrl:
        'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize',
      state: '',
      expiresAt: Date.now() + 600_000,
    });
    const openSpy = vi
      .spyOn(window, 'open')
      .mockReturnValue(null as unknown as Window);

    renderWithProviders(<ConnectorsPage />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Connect Microsoft 365' }),
    );

    await waitFor(() =>
      expect(startConnectorOAuthMock).toHaveBeenCalledWith('admin-token', {
        provider: 'microsoft365',
      }),
    );
    expect(openSpy).toHaveBeenCalledWith(
      'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize',
      '_self',
    );

    openSpy.mockRestore();
  });

  it('tests a connector from its card', async () => {
    testConnectorMock.mockResolvedValue({
      provider: 'github',
      name: 'GitHub',
      ok: true,
      message: 'GitHub is connected for this HybridAI account.',
    });

    renderWithProviders(<ConnectorsPage />);

    const githubTest = await screen.findByRole('button', {
      name: 'Test GitHub',
    });
    fireEvent.click(githubTest);

    await waitFor(() =>
      expect(testConnectorMock).toHaveBeenCalledWith('admin-token', 'github'),
    );
    expect(
      await screen.findByText('GitHub is connected for this HybridAI account.'),
    ).toBeTruthy();
  });

  it('reconnects Google Workspace directly when stored OAuth setup exists', async () => {
    const connected = makeConnectorsResponse();
    connected.connectors[2] = {
      ...connected.connectors[2],
      state: 'connected',
      account: 'eigenarbeit@gmail.com',
      routesConfigured: true,
      clientConfigured: true,
      clientSecretConfigured: true,
      detail: 'OAuth refresh token configured.',
    };
    fetchConnectorsMock.mockResolvedValue(connected);
    startConnectorOAuthMock.mockResolvedValue({
      provider: 'google',
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      state: 'state',
      expiresAt: Date.now() + 3_000,
    });
    const openSpy = vi
      .spyOn(window, 'open')
      .mockReturnValue(null as unknown as Window);

    renderWithProviders(<ConnectorsPage />);

    const reconnectButtons = await screen.findAllByRole('button', {
      name: 'Reconnect',
    });
    fireEvent.click(reconnectButtons[0]);

    await waitFor(() =>
      expect(startConnectorOAuthMock).toHaveBeenCalledWith('admin-token', {
        provider: 'google',
      }),
    );
    expect(openSpy).toHaveBeenCalledWith(
      'https://accounts.google.com/o/oauth2/v2/auth',
      '_blank',
      'noopener',
    );
    expect(screen.queryByText('Connect Google Workspace')).toBeNull();
    expect(screen.queryByLabelText('Scopes')).toBeNull();

    openSpy.mockRestore();
  });

  it('shows the Web application client requirement and redirect URI in the Google dialog', async () => {
    renderWithProviders(<ConnectorsPage />);

    const connectButtons = await screen.findAllByRole('button', {
      name: 'Connect',
    });
    fireEvent.click(connectButtons[1]);

    expect(await screen.findByText('Connect Google Workspace')).toBeTruthy();
    expect(screen.getByText('Web application')).toBeTruthy();
    expect(
      screen.getByText('https://console.example/api/connectors/oauth/callback'),
    ).toBeTruthy();
  });

  it('shows the Desktop app client guidance when the gateway is local', async () => {
    const local = makeConnectorsResponse();
    local.oauthRedirectUri = null;
    fetchConnectorsMock.mockResolvedValue(local);

    renderWithProviders(<ConnectorsPage />);

    const connectButtons = await screen.findAllByRole('button', {
      name: 'Connect',
    });
    fireEvent.click(connectButtons[1]);

    expect(await screen.findByText('Connect Google Workspace')).toBeTruthy();
    expect(screen.getByText('Desktop app')).toBeTruthy();
    expect(screen.queryByText('Web application')).toBeNull();
    expect(
      screen.queryByText(/\/api\/connectors\/oauth\/callback/u),
    ).toBeNull();
  });

  it('opens HybridAI login and saves the pasted API key', async () => {
    const connected = makeConnectorsResponse();
    connected.connectors[0] = {
      ...connected.connectors[0],
      state: 'connected',
      detail: 'hai-...test via runtime-secrets',
    };
    saveHybridAIConnectorKeyMock.mockResolvedValue(connected);
    const openSpy = vi
      .spyOn(window, 'open')
      .mockReturnValue(null as unknown as Window);

    renderWithProviders(<ConnectorsPage />);

    const connectButtons = await screen.findAllByRole('button', {
      name: 'Connect',
    });
    fireEvent.click(connectButtons[0]);
    expect(openSpy).toHaveBeenCalledWith(
      'https://hybridai.one/login?context=hybridclaw&next=/admin_api_keys',
      '_blank',
      'noopener',
    );

    fireEvent.change(await screen.findByLabelText('API key'), {
      target: { value: 'hai-test-secret-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }));

    await waitFor(() =>
      expect(saveHybridAIConnectorKeyMock).toHaveBeenCalledWith(
        'admin-token',
        'hai-test-secret-key',
      ),
    );
    openSpy.mockRestore();
  });
});
