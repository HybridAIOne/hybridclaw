import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminMcpResponse } from '../api/types';
import { renderWithProviders } from '../test-utils';
import { McpPage } from './mcp';

const fetchMcpMock = vi.fn<() => Promise<AdminMcpResponse>>();
const saveMcpServerMock = vi.fn();
const deleteMcpServerMock = vi.fn();
const useAuthMock = vi.fn();

vi.mock('../api/client', () => ({
  fetchMcp: () => fetchMcpMock(),
  saveMcpServer: (token: string, payload: { name: string; config: unknown }) =>
    saveMcpServerMock(token, payload),
  deleteMcpServer: (token: string, name: string) =>
    deleteMcpServerMock(token, name),
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
      },
    ],
  };
}

describe('McpPage', () => {
  beforeEach(() => {
    fetchMcpMock.mockReset();
    saveMcpServerMock.mockReset();
    deleteMcpServerMock.mockReset();
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

  it('switching transport to http reveals the URL field instead of command', async () => {
    fetchMcpMock.mockResolvedValue({ servers: [] });

    renderWithProviders(<McpPage />);

    await screen.findByLabelText('Name');
    expect(screen.getByLabelText('Command')).toBeTruthy();
    expect(screen.queryByLabelText('URL')).toBeNull();

    const transport = screen.getByLabelText('Transport') as HTMLSelectElement;
    fireEvent.change(transport, { target: { value: 'http' } });

    expect(screen.queryByLabelText('Command')).toBeNull();
    expect(screen.getByLabelText('URL')).toBeTruthy();
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
});
