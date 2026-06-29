import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminMcpResponse } from '../api/types';
import { renderWithProviders } from '../test-utils';
import { McpPage } from './mcp';

const fetchMcpMock = vi.fn<() => Promise<AdminMcpResponse>>();
const saveMcpServerMock = vi.fn();
const deleteMcpServerMock = vi.fn();
const startMcpOAuthMock = vi.fn();
const fetchMcpOAuthStatusMock = vi.fn();
const logoutMcpOAuthMock = vi.fn();
const useAuthMock = vi.fn();

vi.mock('../api/client', () => ({
  fetchMcp: () => fetchMcpMock(),
  saveMcpServer: (token: string, payload: { name: string; config: unknown }) =>
    saveMcpServerMock(token, payload),
  deleteMcpServer: (token: string, name: string) =>
    deleteMcpServerMock(token, name),
  startMcpOAuth: (token: string, name: string) =>
    startMcpOAuthMock(token, name),
  fetchMcpOAuthStatus: (token: string, name: string) =>
    fetchMcpOAuthStatusMock(token, name),
  logoutMcpOAuth: (token: string, name: string) =>
    logoutMcpOAuthMock(token, name),
}));

vi.mock('../auth', () => ({
  useAuth: () => useAuthMock(),
}));

function makeMcpResponse(): AdminMcpResponse {
  return {
    servers: [
      {
        name: 'github',
        enabled: true,
        summary: 'stdio · docker run …',
        config: {
          transport: 'stdio',
          command: 'docker',
          args: ['run', 'ghcr.io/github/mcp'],
        },
        auth: { method: 'none' },
      },
    ],
  };
}

function makeOAuthMcpResponse(
  state: 'connected' | 'unauthorized',
): AdminMcpResponse {
  return {
    servers: [
      {
        name: 'linear',
        enabled: true,
        summary: 'http · https://mcp.linear.app/mcp',
        config: {
          transport: 'http',
          url: 'https://mcp.linear.app/mcp',
          auth: 'oauth',
        },
        auth: { method: 'oauth', state },
      },
    ],
  };
}

describe('McpPage', () => {
  beforeEach(() => {
    fetchMcpMock.mockReset();
    saveMcpServerMock.mockReset();
    deleteMcpServerMock.mockReset();
    startMcpOAuthMock.mockReset();
    fetchMcpOAuthStatusMock.mockReset();
    logoutMcpOAuthMock.mockReset();
    useAuthMock.mockReset();
    useAuthMock.mockReturnValue({ token: 'test-token' });
  });

  it('lists configured servers from the API', async () => {
    fetchMcpMock.mockResolvedValue(makeMcpResponse());

    renderWithProviders(<McpPage />);

    expect(await screen.findByRole('button', { name: /github/i })).toBeTruthy();
    expect(screen.getByText('1 configured server')).toBeTruthy();
  });

  it('edits a server through the migrated form and saves the normalized config', async () => {
    fetchMcpMock.mockResolvedValue(makeMcpResponse());
    saveMcpServerMock.mockResolvedValue({
      servers: [
        {
          name: 'github',
          enabled: true,
          summary: 'stdio · uvx mcp-github',
          config: { transport: 'stdio', command: 'uvx', args: ['mcp-github'] },
          auth: { method: 'none' },
        },
      ],
    });

    renderWithProviders(<McpPage />);

    fireEvent.click(await screen.findByRole('button', { name: /github/i }));

    const command = (await screen.findByLabelText(
      'Command',
    )) as HTMLInputElement;
    expect(command.value).toBe('docker');
    fireEvent.change(command, { target: { value: 'uvx' } });

    const args = screen.getByLabelText('Arguments') as HTMLTextAreaElement;
    fireEvent.change(args, { target: { value: 'mcp-github' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save server' }));

    await waitFor(() => expect(saveMcpServerMock).toHaveBeenCalledTimes(1));
    expect(saveMcpServerMock).toHaveBeenCalledWith(
      'test-token',
      expect.objectContaining({
        name: 'github',
        config: expect.objectContaining({
          transport: 'stdio',
          command: 'uvx',
          args: ['mcp-github'],
        }),
      }),
    );
  });

  it('switching transport to stdio reveals the command field instead of URL', async () => {
    fetchMcpMock.mockResolvedValue({ servers: [] });

    renderWithProviders(<McpPage />);

    await screen.findByLabelText('Name');
    expect(screen.getByLabelText('URL')).toBeTruthy();
    expect(screen.queryByLabelText('Command')).toBeNull();

    const transport = screen.getByLabelText('Transport') as HTMLSelectElement;
    fireEvent.change(transport, { target: { value: 'stdio' } });

    expect(screen.queryByLabelText('URL')).toBeNull();
    expect(screen.getByLabelText('Command')).toBeTruthy();
  });

  it('Switch toggles the enabled flag through to the save payload', async () => {
    fetchMcpMock.mockResolvedValue({
      servers: [
        {
          name: 'github',
          enabled: false,
          summary: 'stdio · docker run …',
          config: {
            transport: 'stdio',
            command: 'docker',
            args: ['run', 'ghcr.io/github/mcp'],
            enabled: false,
          },
          auth: { method: 'none' },
        },
      ],
    });
    saveMcpServerMock.mockResolvedValue({ servers: [] });

    renderWithProviders(<McpPage />);

    fireEvent.click(await screen.findByRole('button', { name: /github/i }));
    const toggle = await screen.findByRole('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Save server' }));
    await waitFor(() => expect(saveMcpServerMock).toHaveBeenCalledTimes(1));
    // mcp.tsx omits `enabled` when true (it's the default); the absence of
    // `enabled: false` in the payload is the proof the toggle flipped.
    const [, payload] = saveMcpServerMock.mock.calls[0];
    expect(payload.config.enabled).toBeUndefined();
    expect(payload.config.transport).toBe('stdio');
  });

  it('saves auth: oauth for remote servers when OAuth is selected', async () => {
    fetchMcpMock.mockResolvedValue({ servers: [] });
    saveMcpServerMock.mockResolvedValue({ servers: [] });

    renderWithProviders(<McpPage />);

    const name = await screen.findByLabelText('Name');
    fireEvent.change(name, { target: { value: 'linear' } });
    fireEvent.change(screen.getByLabelText('URL'), {
      target: { value: 'https://mcp.linear.app/mcp' },
    });
    // OAuth is the default auth mode for remote servers.
    expect(
      (screen.getByLabelText('Authentication') as HTMLSelectElement).value,
    ).toBe('oauth');

    fireEvent.click(screen.getByRole('button', { name: 'Save server' }));
    await waitFor(() => expect(saveMcpServerMock).toHaveBeenCalledTimes(1));
    const [, payload] = saveMcpServerMock.mock.calls[0];
    expect(payload.config).toEqual({
      transport: 'http',
      url: 'https://mcp.linear.app/mcp',
      auth: 'oauth',
    });
  });

  it('Connect saves the server, opens the authorization URL, and polls until connected', async () => {
    fetchMcpMock.mockResolvedValue(makeOAuthMcpResponse('unauthorized'));
    saveMcpServerMock.mockResolvedValue(makeOAuthMcpResponse('unauthorized'));
    startMcpOAuthMock.mockResolvedValue({
      serverName: 'linear',
      authorizationUrl: 'https://auth.linear.app/authorize?state=abc',
      state: 'abc',
      expiresAt: Date.now() + 600_000,
    });
    fetchMcpOAuthStatusMock.mockResolvedValue({
      name: 'linear',
      auth: { method: 'oauth', state: 'connected' },
    });
    const openSpy = vi
      .spyOn(window, 'open')
      .mockReturnValue(null as unknown as Window);

    renderWithProviders(<McpPage />);

    fireEvent.click(await screen.findByRole('button', { name: /linear/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(startMcpOAuthMock).toHaveBeenCalledTimes(1), {
      timeout: 5_000,
    });
    expect(saveMcpServerMock).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(
      'https://auth.linear.app/authorize?state=abc',
      '_blank',
      'noopener',
    );
    await waitFor(() => expect(fetchMcpOAuthStatusMock).toHaveBeenCalled(), {
      timeout: 5_000,
    });
    openSpy.mockRestore();
  });

  it('Disconnect clears stored OAuth credentials', async () => {
    fetchMcpMock.mockResolvedValue(makeOAuthMcpResponse('connected'));
    logoutMcpOAuthMock.mockResolvedValue(makeOAuthMcpResponse('unauthorized'));

    renderWithProviders(<McpPage />);

    fireEvent.click(await screen.findByRole('button', { name: /linear/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));

    await waitFor(() => expect(logoutMcpOAuthMock).toHaveBeenCalledTimes(1));
    expect(logoutMcpOAuthMock).toHaveBeenCalledWith('test-token', 'linear');
  });
});
