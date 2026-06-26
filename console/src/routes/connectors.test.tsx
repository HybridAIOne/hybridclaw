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
          'Model routing, bot selection, and managed HybridAI access.',
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
        description: 'Gmail, Calendar, Drive, Docs, Sheets, and People APIs.',
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
          'Microsoft Graph access for mail, calendar, files, Teams, and chats.',
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
    expect(screen.getByText('GOOGLE_OAUTH_CLIENT_ID')).toBeTruthy();
    expect(screen.queryByText(/hybridclaw auth login/u)).toBeNull();
    expect(screen.queryByText('HA')).toBeNull();
    expect(screen.queryByText('M365')).toBeNull();
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
