import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdminBrowserPoolHealthResponse,
  AdminConfig,
  AdminConfigResponse,
} from '../api/types';
import {
  blockerStateMock,
  mockRouterBlocker,
  renderWithProviders,
} from '../test-utils';
import { ConfigPage } from './config';

vi.mock('@tanstack/react-router', () => mockRouterBlocker());

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
    ui: {
      navigation: [
        { href: '/chat', icon: 'chat', label: 'Chat' },
        { href: '/agents', icon: 'agents', label: 'Agents' },
        { href: '/admin', icon: 'admin', label: 'Admin' },
        {
          href: 'https://github.com/HybridAIOne/hybridclaw',
          image: '/icons/github.svg',
          label: 'GitHub',
        },
        { href: '/docs', icon: 'docs', label: 'Docs' },
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
  renderWithProviders(<ConfigPage />);
}

beforeEach(() => {
  blockerStateMock.status = 'idle';
  blockerStateMock.proceed = vi.fn();
  blockerStateMock.reset = vi.fn();
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

    const provider = (await screen.findByLabelText(
      'Provider',
    )) as HTMLSelectElement;
    fireEvent.change(provider, { target: { value: 'managed-cloud' } });
    expect(screen.getByDisplayValue('main')).toBeTruthy();
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
    fireEvent.change(screen.getByLabelText('Default tenant id (optional)'), {
      target: { value: 'tenant-a' },
    });
    expect(
      screen
        .getByRole('link', { name: 'Manage network policy' })
        .getAttribute('href'),
    ).toBe('/admin/network-policy');
    const actionPriceInput = screen.getByLabelText(
      'Action price USD',
    ) as HTMLInputElement;
    fireEvent.change(actionPriceInput, {
      target: { value: '0.' },
    });
    expect(actionPriceInput.value).toBe('0.');
    fireEvent.change(actionPriceInput, {
      target: { value: '0.0005' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

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

  it('hides Save changes until a field is edited, and Discard restores the saved state', async () => {
    renderConfigPage();

    const healthHost = (await screen.findByLabelText(
      'Health host',
    )) as HTMLInputElement;
    expect(healthHost.value).toBe('127.0.0.1');
    expect(screen.getByText('Saved')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();

    fireEvent.change(healthHost, { target: { value: '10.0.0.1' } });

    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    await waitFor(() =>
      expect(
        (screen.getByLabelText('Health host') as HTMLInputElement).value,
      ).toBe('127.0.0.1'),
    );
    expect(screen.getByText('Saved')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(saveConfigMock).not.toHaveBeenCalled();
  });

  it('returns to a clean state after saving an edited config', async () => {
    // Regression: the saved config must flow back into the source query cache,
    // otherwise `isDirty` (draft vs. source) never clears after a save — the
    // page stays "Unsaved changes" and Discard would revert the just-saved
    // edit. A real server echoes the persisted config back, so mirror that
    // here. The default beforeEach mock returns the *original* config, which
    // is what hid this bug.
    saveConfigMock.mockImplementation((_token: string, cfg: AdminConfig) =>
      Promise.resolve({ path: '/tmp/config.json', config: cfg }),
    );

    renderConfigPage();

    const healthHost = (await screen.findByLabelText(
      'Health host',
    )) as HTMLInputElement;
    fireEvent.change(healthHost, { target: { value: '10.0.0.1' } });
    expect(screen.getByText('Unsaved changes')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledTimes(1));
    // Once the save resolves the page is clean again — no lingering dirty UI.
    await waitFor(() => expect(screen.getByText('Saved')).toBeTruthy());
    expect(screen.queryByText('Unsaved changes')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();
    // The saved value persists rather than reverting to the original fetch.
    expect(
      (screen.getByLabelText('Health host') as HTMLInputElement).value,
    ).toBe('10.0.0.1');
  });

  it('edits top navigation links from the form view', async () => {
    renderConfigPage();

    const firstLabel = (await screen.findByLabelText(
      'Navigation item 1 label',
    )) as HTMLInputElement;
    fireEvent.change(firstLabel, { target: { value: 'Channels' } });
    fireEvent.change(screen.getByLabelText('Navigation item 1 href'), {
      target: { value: '/admin/channels' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove navigation item 4' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add link' }));
    fireEvent.change(screen.getByLabelText('Navigation item 5 label'), {
      target: { value: 'HybridAI' },
    });
    fireEvent.change(screen.getByLabelText('Navigation item 5 href'), {
      target: { value: 'https://hybridai.one/admin_startpage' },
    });
    fireEvent.change(screen.getByLabelText('Navigation item 5 image'), {
      target: { value: '/icons/hybridai.png' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledTimes(1));
    expect(saveConfigMock).toHaveBeenCalledWith(
      'admin-token',
      expect.objectContaining({
        ui: {
          navigation: [
            { href: '/admin/channels', label: 'Channels' },
            { href: '/agents', icon: 'agents', label: 'Agents' },
            { href: '/admin', icon: 'admin', label: 'Admin' },
            { href: '/docs', icon: 'docs', label: 'Docs' },
            {
              href: 'https://hybridai.one/admin_startpage',
              image: '/icons/hybridai.png',
              label: 'HybridAI',
            },
          ],
        },
      }),
    );
  });

  it('adds blank navigation rows and validates links before saving', async () => {
    renderConfigPage();

    await screen.findByLabelText('Navigation item 1 label');
    fireEvent.click(screen.getByRole('button', { name: 'Add link' }));

    const label = screen.getByLabelText(
      'Navigation item 6 label',
    ) as HTMLInputElement;
    const href = screen.getByLabelText(
      'Navigation item 6 href',
    ) as HTMLInputElement;
    const image = screen.getByLabelText(
      'Navigation item 6 image',
    ) as HTMLInputElement;
    expect(label.value).toBe('');
    expect(label.maxLength).toBe(48);
    expect(href.value).toBe('');
    expect(image.value).toBe('');
    expect(screen.getAllByRole('alert')).toHaveLength(2);
    expect(
      (
        screen.getByRole('button', {
          name: 'Save changes',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    fireEvent.change(label, { target: { value: 'Bad link' } });
    fireEvent.change(href, { target: { value: 'javascript:alert(1)' } });
    fireEvent.change(image, { target: { value: 'javascript:alert(1)' } });

    expect(
      screen.getByText(/local path starting with \/ or an http\(s\) URL/i),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /local image path starting with \/ or an http\(s\) image URL/i,
      ),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole('button', {
          name: 'Save changes',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(saveConfigMock).not.toHaveBeenCalled();

    fireEvent.change(href, { target: { value: 'https://hybridclaw.io' } });
    fireEvent.change(image, { target: { value: '/icons/cloud.svg' } });

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(
      (
        screen.getByRole('button', {
          name: 'Save changes',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it('surfaces a FieldError for malformed JSON in raw mode and blocks saving', async () => {
    renderConfigPage();

    await screen.findByLabelText('Health host');
    fireEvent.click(screen.getByRole('button', { name: 'JSON' }));

    const editor = (await screen.findByLabelText(
      'config.json',
    )) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: '{ not json' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(saveConfigMock).not.toHaveBeenCalled();

    fireEvent.change(editor, {
      target: { value: JSON.stringify({ ...makeConfig(), version: 2 }) },
    });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledTimes(1));
    expect(saveConfigMock).toHaveBeenLastCalledWith(
      'admin-token',
      expect.objectContaining({ version: 2 }),
    );
  });

  it('keeps raw mode open when toggling back to form view with invalid JSON', async () => {
    renderConfigPage();

    await screen.findByLabelText('Health host');
    fireEvent.click(screen.getByRole('button', { name: 'JSON' }));

    const editor = (await screen.findByLabelText(
      'config.json',
    )) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'not json' } });
    fireEvent.click(screen.getByRole('button', { name: 'Form' }));

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.queryByLabelText('Health host')).toBeNull();
    expect(screen.getByRole('button', { name: 'Form' })).toBeTruthy();
    expect(saveConfigMock).not.toHaveBeenCalled();
  });

  it('parses valid JSON when switching from raw mode back to the form view', async () => {
    renderConfigPage();

    await screen.findByLabelText('Health host');
    fireEvent.click(screen.getByRole('button', { name: 'JSON' }));

    const editor = (await screen.findByLabelText(
      'config.json',
    )) as HTMLTextAreaElement;
    const edited = { ...makeConfig() };
    edited.ops = { ...edited.ops, healthHost: '10.20.30.40' };
    fireEvent.change(editor, { target: { value: JSON.stringify(edited) } });
    fireEvent.click(screen.getByRole('button', { name: 'Form' }));

    const healthHost = (await screen.findByLabelText(
      'Health host',
    )) as HTMLInputElement;
    expect(healthHost.value).toBe('10.20.30.40');
    expect(screen.getByRole('button', { name: 'JSON' })).toBeTruthy();
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
  });

  it('keeps "0." in flight for the browser-use-cloud price field and persists the parsed value', async () => {
    renderConfigPage();

    const provider = (await screen.findByLabelText(
      'Provider',
    )) as HTMLSelectElement;
    fireEvent.change(provider, { target: { value: 'browser-use-cloud' } });

    const browserPrice = screen.getByLabelText(
      'Browser price USD/min',
    ) as HTMLInputElement;
    fireEvent.change(browserPrice, { target: { value: '0.' } });
    expect(browserPrice.value).toBe('0.');
    fireEvent.change(browserPrice, { target: { value: '0.25' } });
    expect(browserPrice.value).toBe('0.25');

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledTimes(1));
    expect(saveConfigMock).toHaveBeenCalledWith(
      'admin-token',
      expect.objectContaining({
        browser: expect.objectContaining({
          provider: 'browser-use-cloud',
          browserUseCloud: expect.objectContaining({
            pricing: expect.objectContaining({ browserUsdPerMinute: 0.25 }),
          }),
        }),
      }),
    );
  });

  it('shows the unsaved-changes dialog and routes both choices through the blocker', async () => {
    blockerStateMock.status = 'blocked';
    renderConfigPage();

    await screen.findByLabelText('Health host');
    expect(
      screen.getByRole('alertdialog', { name: 'Discard unsaved changes?' }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(blockerStateMock.reset).toHaveBeenCalledTimes(1);
    expect(blockerStateMock.proceed).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Discard and leave' }));
    expect(blockerStateMock.proceed).toHaveBeenCalledTimes(1);
  });

  it('disables Save when a field-level validator rejects the input', async () => {
    renderConfigPage();

    const memory = (await screen.findByLabelText('Memory')) as HTMLInputElement;
    fireEvent.change(memory, { target: { value: 'not-a-size' } });

    const save = (await screen.findByRole('button', {
      name: 'Save changes',
    })) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.click(save);
    expect(saveConfigMock).not.toHaveBeenCalled();

    fireEvent.change(memory, { target: { value: '4g' } });
    await waitFor(() =>
      expect(
        (
          screen.getByRole('button', {
            name: 'Save changes',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
  });

  it('shows and saves mac-cua browser config', async () => {
    const config = makeConfig();
    if (!config.browser) throw new Error('test config is missing browser');
    config.browser = {
      ...config.browser,
      provider: 'mac-cua',
      allowPrivateNetwork: true,
      macCua: {
        browser: 'safari',
        driverCommand: '',
        driverArgs: ['mcp', '--no-daemon-relaunch'],
        screenshotMode: 'som',
      },
    };
    fetchConfigMock.mockResolvedValueOnce({ path: '/tmp/config.json', config });

    renderConfigPage();

    const provider = (await screen.findByLabelText(
      'Provider',
    )) as HTMLSelectElement;
    expect(provider.value).toBe('mac-cua');
    expect(screen.getByDisplayValue('safari')).toBeTruthy();
    expect(screen.getByDisplayValue('mcp --no-daemon-relaunch')).toBeTruthy();

    fireEvent.change(screen.getByDisplayValue('safari'), {
      target: { value: 'chrome' },
    });
    fireEvent.change(screen.getByPlaceholderText('cua-driver'), {
      target: { value: '/opt/cua-driver' },
    });
    fireEvent.change(screen.getByDisplayValue('mcp --no-daemon-relaunch'), {
      target: { value: 'mcp' },
    });
    fireEvent.change(screen.getByDisplayValue('som'), {
      target: { value: 'ax' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledTimes(1));
    expect(saveConfigMock).toHaveBeenCalledWith(
      'admin-token',
      expect.objectContaining({
        browser: expect.objectContaining({
          provider: 'mac-cua',
          allowPrivateNetwork: true,
          macCua: {
            browser: 'chrome',
            driverCommand: '/opt/cua-driver',
            driverArgs: ['mcp'],
            screenshotMode: 'ax',
          },
        }),
      }),
    );
  });
});
