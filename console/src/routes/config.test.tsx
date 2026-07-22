import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminConfig, AdminConfigResponse } from '../api/types';
import {
  blockerStateMock,
  mockRouterBlocker,
  renderWithProviders,
} from '../test-utils';
import { ConfigPage } from './config';

vi.mock('@tanstack/react-router', () => mockRouterBlocker());

const fetchConfigMock = vi.fn<() => Promise<AdminConfigResponse>>();
const saveConfigMock = vi.fn();
const useAuthMock = vi.fn();

vi.mock('../api/client', () => ({
  fetchConfig: () => fetchConfigMock(),
  saveConfig: (...args: unknown[]) => saveConfigMock(...args),
}));

vi.mock('../auth', () => ({
  useAuth: () => useAuthMock(),
}));

function makeConfig(): AdminConfig {
  return {
    version: 36,
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
      line: '',
    },
    container: {
      sandboxMode: 'container',
      image: 'hybridclaw:latest',
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
    ui: {
      navigation: [
        { href: '/chat', icon: 'chat', label: 'Chat' },
        { href: '/admin', icon: 'admin', label: 'Admin' },
      ],
    },
    ops: {
      healthHost: '127.0.0.1',
      healthPort: 9090,
      webApiToken: '',
      gatewayBaseUrl: '',
      gatewayInternalBaseUrl: 'http://127.0.0.1:9090',
      gatewayApiToken: '',
      dbPath: '',
      logLevel: 'info',
      logRequests: false,
      debugModelResponses: false,
    },
    browser: {
      provider: 'local',
      allowPrivateNetwork: false,
      local: { profileDir: '', headed: false },
      camofox: { profileDir: '', headed: false },
      managedCloud: {
        endpointUrl: 'http://127.0.0.1:8787',
        poolTokenRef: undefined,
        defaultTenantId: '',
        pricing: { actionUsd: 0 },
      },
      browserUseCloud: {
        apiKeyRef: undefined,
        projectId: '',
        profileId: '',
        region: '',
        keepAlive: false,
        pricing: { browserUsdPerMinute: 0, actionUsd: 0 },
      },
      macCua: {
        browser: 'chrome',
        driverCommand: '',
        driverArgs: [],
        screenshotMode: 'som',
      },
    },
  } as unknown as AdminConfig;
}

function renderConfigPage(): void {
  renderWithProviders(<ConfigPage />);
}

beforeEach(() => {
  window.history.replaceState(null, '', '/admin/config');
  blockerStateMock.status = 'idle';
  blockerStateMock.proceed = vi.fn();
  blockerStateMock.reset = vi.fn();
  useAuthMock.mockReturnValue({ token: 'admin-token' });
  const config = makeConfig();
  fetchConfigMock.mockResolvedValue({ path: '/tmp/config.json', config });
  saveConfigMock.mockImplementation((_token: string, next: AdminConfig) =>
    Promise.resolve({ path: '/tmp/config.json', config: next }),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('ConfigPage', () => {
  it('renders schema-backed sections without the global JSON mode', async () => {
    renderConfigPage();

    expect(await screen.findByLabelText('Settings sections')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ops' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Container' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Browser' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'JSON' })).toBeNull();
    expect(screen.queryByText(/switch to json/i)).toBeNull();
  });

  it('edits, discards, and saves scalar settings', async () => {
    renderConfigPage();

    const host = (await screen.findByLabelText(
      'Health Host',
    )) as HTMLInputElement;
    fireEvent.change(host, { target: { value: '10.0.0.1' } });
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(host.value).toBe('127.0.0.1'));

    fireEvent.change(host, { target: { value: '10.0.0.2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledTimes(1));
    expect(saveConfigMock).toHaveBeenCalledWith(
      'admin-token',
      expect.objectContaining({
        ops: expect.objectContaining({ healthHost: '10.0.0.2' }),
      }),
    );
    await waitFor(() => expect(screen.getByText('Saved')).toBeTruthy());
  });

  it('navigates sections and edits inline structured values', async () => {
    renderConfigPage();

    await screen.findByLabelText('Settings sections');
    fireEvent.click(screen.getByRole('button', { name: 'UI' }));
    const navigation = screen.getByLabelText('Navigation');
    fireEvent.change(navigation, {
      target: {
        value: JSON.stringify([{ href: '/chat', label: 'Assistant' }]),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledTimes(1));
    expect(saveConfigMock).toHaveBeenCalledWith(
      'admin-token',
      expect.objectContaining({
        ui: { navigation: [{ href: '/chat', label: 'Assistant' }] },
      }),
    );
  });

  it('blocks saving invalid inline JSON', async () => {
    renderConfigPage();

    await screen.findByLabelText('Settings sections');
    fireEvent.click(screen.getByRole('button', { name: 'UI' }));
    fireEvent.change(screen.getByLabelText('Navigation'), {
      target: { value: '{ invalid' },
    });

    expect(await screen.findByRole('alert')).toBeTruthy();
    const save = screen.getByRole('button', {
      name: 'Save changes',
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(saveConfigMock).not.toHaveBeenCalled();
  });

  it('searches individual settings and links page-owned entries', async () => {
    renderConfigPage();

    const search = await screen.findByLabelText('Search settings');
    fireEvent.change(search, { target: { value: 'log level' } });
    expect(screen.getByText('Log Level')).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Open Logs →' }).getAttribute('href'),
    ).toBe('/admin/logs');
    expect(screen.queryByRole('combobox', { name: 'Log Level' })).toBeNull();
  });

  it('routes provider-owned sections to Providers', async () => {
    renderConfigPage();

    await screen.findByLabelText('Settings sections');
    fireEvent.click(screen.getByRole('button', { name: 'HybridAI ↗' }));
    expect(
      screen
        .getByRole('link', { name: 'Open Providers →' })
        .getAttribute('href'),
    ).toBe('/admin/models');
  });

  it('loads a linkable section and query from the URL', async () => {
    window.history.replaceState(
      null,
      '',
      '/admin/config?section=container&q=memory',
    );
    renderConfigPage();

    expect(
      ((await screen.findByLabelText('Search settings')) as HTMLInputElement)
        .value,
    ).toBe('memory');
    expect(screen.getByLabelText('Memory')).toBeTruthy();
  });

  it('keeps the unsaved-changes blocker for generated fields', async () => {
    blockerStateMock.status = 'blocked';
    renderConfigPage();

    expect(
      await screen.findByRole('alertdialog', {
        name: 'Discard unsaved changes?',
      }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(blockerStateMock.reset).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Discard and leave' }));
    expect(blockerStateMock.proceed).toHaveBeenCalledTimes(1);
  });
});
