import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminConnectorsResponse } from '../api/types';
import { renderWithProviders } from '../test-utils';
import { ConnectorsPage } from './connectors';

const fetchConnectorsMock = vi.fn<() => Promise<AdminConnectorsResponse>>();
const logoutConnectorMock = vi.fn();
const saveHybridAIConnectorKeyMock = vi.fn();
const startConnectorOAuthMock = vi.fn();
const useAuthMock = vi.fn();

vi.mock('../api/client', () => ({
  fetchConnectors: () => fetchConnectorsMock(),
  logoutConnector: (...args: unknown[]) => logoutConnectorMock(...args),
  saveHybridAIConnectorKey: (...args: unknown[]) =>
    saveHybridAIConnectorKeyMock(...args),
  startConnectorOAuth: (...args: unknown[]) => startConnectorOAuthMock(...args),
}));

vi.mock('../auth', () => ({
  useAuth: () => useAuthMock(),
}));

function makeConnectorsResponse(): AdminConnectorsResponse {
  return {
    secretsPath: '/tmp/credentials.json',
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
        state: 'connected',
        authKind: 'oauth',
        account: 'user@example.com',
        detail: 'OAuth refresh token configured.',
        scopes: ['offline_access', 'User.Read'],
        routesConfigured: true,
        clientConfigured: true,
        clientSecretConfigured: false,
        tenantId: 'organizations',
        loginUrl: null,
        adminConsentUrl:
          'https://login.microsoftonline.com/organizations/adminconsent?client_id=microsoft-client-id',
        setupSecretNames: [
          'MICROSOFT_365_ACCOUNT',
          'MICROSOFT_365_TENANT_ID',
          'MICROSOFT_365_CLIENT_ID',
        ],
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
    useAuthMock.mockReset();
    useAuthMock.mockReturnValue({ token: 'admin-token' });
    fetchConnectorsMock.mockResolvedValue(makeConnectorsResponse());
  });

  it('renders prebuilt connector cards and setup state', async () => {
    renderWithProviders(<ConnectorsPage />);

    expect(await screen.findByText('HybridAI')).toBeTruthy();
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

  it('opens Microsoft 365 as a guided work-account sign-in flow', async () => {
    renderWithProviders(<ConnectorsPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));

    expect(screen.getByText('Sign in with your work account')).toBeTruthy();
    expect(screen.getByText(/work or school account/u)).toBeTruthy();
    expect(screen.getByText(/approve access during sign-in/u)).toBeTruthy();
    expect(screen.queryByLabelText('Tenant')).toBeNull();
    expect(screen.queryByLabelText('Client ID')).toBeNull();
    expect(screen.queryByLabelText('Client secret')).toBeNull();
    expect(screen.queryByLabelText('Scopes')).toBeNull();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
  });

  it('reconnects Google Workspace directly when stored OAuth setup exists', async () => {
    const connected = makeConnectorsResponse();
    connected.connectors[1] = {
      ...connected.connectors[1],
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
