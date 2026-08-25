/**
 * Plugin page interaction tests — operator installs must reach the local web
 * command boundary and refresh the gateway-backed registry on success.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminCommandResult, AdminPluginsResponse } from '../api/types';
import { renderWithProviders } from '../test-utils';
import { PluginsPage } from './plugins';

const fetchPluginsMock = vi.fn<() => Promise<AdminPluginsResponse>>();
const installOfficialPluginMock =
  vi.fn<(token: string, pluginId: string) => Promise<AdminCommandResult>>();

vi.mock('../api/client', () => ({
  fetchPlugins: () => fetchPluginsMock(),
  installOfficialPlugin: (token: string, pluginId: string) =>
    installOfficialPluginMock(token, pluginId),
}));

vi.mock('../auth', () => ({
  useAuth: () => ({ token: 'test-token' }),
}));

function makeResponse(): AdminPluginsResponse {
  return {
    totals: {
      totalPlugins: 1,
      enabledPlugins: 1,
      failedPlugins: 0,
      commands: 1,
      tools: 2,
      hooks: 1,
    },
    plugins: [
      {
        id: 'memory-store',
        name: 'Memory Store',
        version: '1.2.3',
        description: 'Durable agent memory.',
        source: 'home',
        enabled: true,
        status: 'loaded',
        error: null,
        commands: ['memory'],
        tools: ['memory_search', 'memory_write'],
        hooks: ['before_prompt'],
      },
    ],
    availableOfficialPlugins: [
      {
        id: 'whatsapp',
        name: 'WhatsApp',
        version: null,
        description: 'Official WhatsApp transport maintained by HybridAIOne.',
        source: 'channel',
      },
    ],
  };
}

describe('PluginsPage', () => {
  beforeEach(() => {
    fetchPluginsMock.mockReset();
    installOfficialPluginMock.mockReset();
    fetchPluginsMock.mockResolvedValue(makeResponse());
  });

  it('installs a selected official plugin and refreshes the registry', async () => {
    installOfficialPluginMock.mockResolvedValue({
      kind: 'info',
      title: 'Plugin Installed',
      text: 'Installed plugin `demo-plugin`.',
    });

    renderWithProviders(<PluginsPage />);
    await screen.findByText('Memory Store');

    fireEvent.click(screen.getByRole('button', { name: 'Install WhatsApp' }));

    await waitFor(() => {
      expect(installOfficialPluginMock).toHaveBeenCalledWith(
        'test-token',
        'whatsapp',
      );
      expect(fetchPluginsMock).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByText('Plugin Installed')).toBeTruthy();
  });

  it('surfaces command errors and keeps the official plugin available', async () => {
    installOfficialPluginMock.mockResolvedValue({
      kind: 'error',
      title: 'Plugin Install Failed',
      text: 'Plugin manifest was not found.',
    });

    renderWithProviders(<PluginsPage />);
    await screen.findByText('Memory Store');

    fireEvent.click(screen.getByRole('button', { name: 'Install WhatsApp' }));

    expect(await screen.findByText('Plugin installation failed')).toBeTruthy();
    expect(screen.getByText('Plugin manifest was not found.')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Install WhatsApp' }),
    ).toBeTruthy();
    expect(fetchPluginsMock).toHaveBeenCalledTimes(1);
  });

  it('does not expose an arbitrary plugin source input', async () => {
    renderWithProviders(<PluginsPage />);
    await screen.findByText('Memory Store');

    expect(screen.queryByLabelText('Plugin source')).toBeNull();
    expect(screen.getByText('Official · channel')).toBeTruthy();
    expect(installOfficialPluginMock).not.toHaveBeenCalled();
  });
});
