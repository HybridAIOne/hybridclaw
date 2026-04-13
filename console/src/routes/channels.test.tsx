import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminConfig, AdminConfigResponse } from '../api/types';
import { ToastProvider } from '../components/toast';
import { ChannelsPage } from './channels';

const fetchConfigMock = vi.fn<() => Promise<AdminConfigResponse>>();
const saveConfigMock = vi.fn();
const setRuntimeSecretMock = vi.fn();
const validateTokenMock = vi.fn();
const useAuthMock = vi.fn();

vi.mock('../api/client', () => ({
  fetchConfig: () => fetchConfigMock(),
  saveConfig: (...args: unknown[]) => saveConfigMock(...args),
  setRuntimeSecret: (...args: unknown[]) => setRuntimeSecretMock(...args),
  validateToken: (...args: unknown[]) => validateTokenMock(...args),
}));

vi.mock('../auth', () => ({
  useAuth: () => useAuthMock(),
}));

function makeConfig(overrides: Partial<AdminConfig> = {}): AdminConfig {
  return {
    version: 1,
    hybridai: {
      baseUrl: 'https://hybridai.one',
      defaultModel: 'gpt-5',
      defaultChatbotId: '',
      maxTokens: 4096,
      enableRag: true,
      models: ['gpt-5'],
    },
    discord: {
      prefix: '!claw',
      guildMembersIntent: false,
      presenceIntent: false,
      commandsOnly: false,
      commandMode: 'public',
      commandAllowedUserIds: [],
      commandUserId: '',
      groupPolicy: 'open',
      sendPolicy: 'open',
      sendAllowedChannelIds: [],
      freeResponseChannels: [],
      textChunkLimit: 2000,
      maxLinesPerMessage: 17,
      humanDelay: {
        mode: 'natural',
        minMs: 800,
        maxMs: 2500,
      },
      typingMode: 'thinking',
      presence: {
        enabled: true,
        intervalMs: 30000,
        healthyText: 'Watching the channels',
        degradedText: 'Thinking slowly...',
        exhaustedText: 'Taking a break',
        activityType: 'watching',
      },
      lifecycleReactions: {
        enabled: true,
        removeOnComplete: true,
        phases: {
          queued: '⏳',
          thinking: '🤔',
          toolUse: '⚙️',
          streaming: '✍️',
          done: '✅',
          error: '❌',
        },
      },
      debounceMs: 2500,
      ackReaction: '👀',
      ackReactionScope: 'group-mentions',
      removeAckAfterReply: true,
      rateLimitPerUser: 0,
      rateLimitExemptRoles: [],
      suppressPatterns: ['/stop', '/pause', 'brb', 'afk'],
      maxConcurrentPerChannel: 2,
      guilds: {},
    },
    msteams: {
      enabled: false,
      appId: '',
      tenantId: '',
      webhook: {
        port: 3978,
        path: '/api/msteams/messages',
      },
      groupPolicy: 'allowlist',
      dmPolicy: 'allowlist',
      allowFrom: [],
      teams: {},
      requireMention: true,
      textChunkLimit: 4000,
      replyStyle: 'thread',
      mediaMaxMb: 20,
      dangerouslyAllowNameMatching: false,
      mediaAllowHosts: [],
      mediaAuthAllowHosts: [],
    },
    slack: {
      enabled: false,
      groupPolicy: 'allowlist',
      dmPolicy: 'allowlist',
      allowFrom: [],
      groupAllowFrom: [],
      requireMention: true,
      textChunkLimit: 12000,
      replyStyle: 'thread',
      mediaMaxMb: 20,
    },
    telegram: {
      enabled: false,
      botToken: '',
      pollIntervalMs: 1500,
      dmPolicy: 'disabled',
      groupPolicy: 'disabled',
      allowFrom: [],
      groupAllowFrom: [],
      requireMention: true,
      textChunkLimit: 4000,
      mediaMaxMb: 20,
    },
    whatsapp: {
      dmPolicy: 'pairing',
      groupPolicy: 'disabled',
      allowFrom: [],
      groupAllowFrom: [],
      textChunkLimit: 4000,
      debounceMs: 2500,
      sendReadReceipts: true,
      ackReaction: '👀',
      mediaMaxMb: 20,
    },
    imessage: {
      enabled: false,
      backend: 'local',
      cliPath: 'imsg',
      dbPath: '/Users/example/Library/Messages/chat.db',
      pollIntervalMs: 2500,
      serverUrl: '',
      password: '',
      webhookPath: '/api/imessage/webhook',
      allowPrivateNetwork: false,
      dmPolicy: 'allowlist',
      groupPolicy: 'disabled',
      allowFrom: [],
      groupAllowFrom: [],
      textChunkLimit: 4000,
      debounceMs: 2500,
      mediaMaxMb: 20,
    },
    email: {
      enabled: true,
      imapHost: 'imap.example.com',
      imapPort: 993,
      imapSecure: true,
      smtpHost: 'smtp.example.com',
      smtpPort: 587,
      smtpSecure: false,
      address: 'bot@example.com',
      password: 'secret',
      pollIntervalMs: 30000,
      folders: ['INBOX'],
      allowFrom: ['ops@example.com'],
      textChunkLimit: 50000,
      mediaMaxMb: 20,
    },
    container: {
      sandboxMode: 'container',
      image: 'ghcr.io/hybridclaw',
      memory: '2g',
      memorySwap: '2g',
      cpus: '2',
      network: 'bridge',
      timeoutMs: 120000,
      binds: [],
      additionalMounts: '',
      maxOutputBytes: 200000,
      maxConcurrent: 2,
    },
    ops: {
      healthHost: '127.0.0.1',
      healthPort: 3001,
      webApiToken: 'token',
      gatewayBaseUrl: 'http://localhost:3000',
      gatewayApiToken: 'token',
      dbPath: '/tmp/hybridclaw.db',
      logLevel: 'info',
    },
    ...overrides,
  };
}

function renderChannelsPage(): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <ChannelsPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('ChannelsPage', () => {
  beforeEach(() => {
    fetchConfigMock.mockReset();
    saveConfigMock.mockReset();
    setRuntimeSecretMock.mockReset();
    validateTokenMock.mockReset();
    useAuthMock.mockReset();
    const gatewayStatus = {
      discord: {
        tokenConfigured: false,
        tokenSource: null,
      },
      slack: {
        botTokenConfigured: false,
        botTokenSource: null,
        appTokenConfigured: false,
        appTokenSource: null,
      },
      telegram: {
        tokenConfigured: false,
        tokenSource: null,
      },
      email: {
        passwordConfigured: false,
        passwordSource: null,
      },
      imessage: {
        passwordConfigured: false,
        passwordSource: null,
      },
      whatsapp: {
        linked: false,
        jid: null,
        pairingQrText: null,
        pairingUpdatedAt: null,
      },
    };
    useAuthMock.mockReturnValue({
      token: 'test-token',
      gatewayStatus,
    });
    validateTokenMock.mockResolvedValue({
      status: 'ok',
      webAuthConfigured: true,
      version: 'test',
      imageTag: null,
      uptime: 1,
      sessions: 0,
      activeContainers: 0,
      defaultModel: 'gpt-5',
      ragDefault: true,
      timestamp: new Date().toISOString(),
      ...gatewayStatus,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('lists configured transports instead of an explicit binding empty state', async () => {
    fetchConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config: makeConfig(),
    });

    renderChannelsPage();

    await screen.findByRole('button', { name: /Discord/i });
    screen.getByRole('button', { name: /Telegram/i });
    screen.getByRole('button', { name: /Email/i });
    expect(screen.queryByText('No explicit bindings exist yet.')).toBeNull();
  });

  it('saves edited channel settings through the config endpoint', async () => {
    const config = makeConfig();

    fetchConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config,
    });
    saveConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config: {
        ...config,
        email: {
          ...config.email,
          address: 'support@example.com',
        },
      },
    });

    renderChannelsPage();

    await screen.findByRole('button', { name: /Email/i });

    fireEvent.click(screen.getByRole('button', { name: /Email/i }));
    fireEvent.change(screen.getByLabelText('Address'), {
      target: { value: 'support@example.com' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Save channel settings' }),
    );

    await waitFor(() => {
      expect(saveConfigMock).toHaveBeenCalledTimes(1);
    });

    expect(saveConfigMock).toHaveBeenCalledWith(
      'test-token',
      expect.objectContaining({
        email: expect.objectContaining({
          address: 'support@example.com',
        }),
      }),
    );
  });

  it('shows WhatsApp as available until it is linked', async () => {
    fetchConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config: makeConfig(),
    });

    renderChannelsPage();

    const whatsappButton = await screen.findByRole('button', {
      name: /WhatsApp/i,
    });
    expect(whatsappButton.textContent || '').toContain('available');
    expect(whatsappButton.textContent || '').not.toContain('pairing');
  });

  it('shows Discord as available when the token is not configured', async () => {
    fetchConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config: makeConfig(),
    });

    renderChannelsPage();

    const discordButton = await screen.findByRole('button', {
      name: /Discord/i,
    });
    expect(discordButton.textContent || '').toContain('available');
    expect(discordButton.textContent || '').not.toContain('active');
  });

  it('shows Slack as active only when both Socket Mode tokens are configured', async () => {
    fetchConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config: makeConfig({
        slack: {
          ...makeConfig().slack,
          enabled: true,
        },
      }),
    });
    validateTokenMock.mockResolvedValue({
      status: 'ok',
      webAuthConfigured: true,
      version: 'test',
      imageTag: null,
      uptime: 1,
      sessions: 0,
      activeContainers: 0,
      defaultModel: 'gpt-5',
      ragDefault: true,
      timestamp: new Date().toISOString(),
      slack: {
        botTokenConfigured: true,
        botTokenSource: 'runtime-secrets',
        appTokenConfigured: true,
        appTokenSource: 'runtime-secrets',
      },
    });

    renderChannelsPage();

    const slackButton = await screen.findByRole('button', {
      name: /Slack/i,
    });
    expect(slackButton.textContent || '').toContain('active');

    fireEvent.click(slackButton);
    expect(
      screen.getByRole('heading', { name: 'Slack settings' }),
    ).toBeTruthy();
    expect(screen.getByText('Bot token')).toBeTruthy();
    expect(screen.getByText('App token')).toBeTruthy();
  });

  it('shows Discord as active in command-only mode when the token is configured', async () => {
    fetchConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config: makeConfig({
        discord: {
          ...makeConfig().discord,
          commandsOnly: true,
          groupPolicy: 'disabled',
        },
      }),
    });
    validateTokenMock.mockResolvedValue({
      status: 'ok',
      webAuthConfigured: true,
      version: 'test',
      imageTag: null,
      uptime: 1,
      sessions: 0,
      activeContainers: 0,
      defaultModel: 'gpt-5',
      ragDefault: true,
      timestamp: new Date().toISOString(),
      discord: {
        tokenConfigured: true,
        tokenSource: 'runtime-secrets',
      },
      telegram: {
        tokenConfigured: false,
        tokenSource: null,
      },
      email: {
        passwordConfigured: false,
        passwordSource: null,
      },
      imessage: {
        passwordConfigured: false,
        passwordSource: null,
      },
      whatsapp: {
        linked: false,
        jid: null,
        pairingQrText: null,
        pairingUpdatedAt: null,
      },
    });

    renderChannelsPage();

    const discordButton = await screen.findByRole('button', {
      name: /Discord/i,
    });
    expect(discordButton.textContent || '').toContain('active');
  });

  it('shows Telegram as configured when enabled without a token', async () => {
    fetchConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config: makeConfig({
        telegram: {
          ...makeConfig().telegram,
          enabled: true,
          dmPolicy: 'allowlist',
          allowFrom: ['@ops_user'],
        },
      }),
    });

    renderChannelsPage();

    const telegramButton = await screen.findByRole('button', {
      name: /Telegram/i,
    });
    expect(telegramButton.textContent || '').toContain('configured');
    expect(telegramButton.textContent || '').not.toContain('active');
  });

  it('renders the live WhatsApp pairing QR on the channel page', async () => {
    fetchConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config: makeConfig(),
    });
    validateTokenMock.mockResolvedValue({
      status: 'ok',
      webAuthConfigured: true,
      version: 'test',
      imageTag: null,
      uptime: 1,
      sessions: 0,
      activeContainers: 0,
      defaultModel: 'gpt-5',
      ragDefault: true,
      timestamp: new Date().toISOString(),
      email: {
        passwordConfigured: false,
        passwordSource: null,
      },
      imessage: {
        passwordConfigured: false,
        passwordSource: null,
      },
      whatsapp: {
        linked: false,
        jid: null,
        pairingQrText: '▄▄\n██',
        pairingUpdatedAt: new Date().toISOString(),
      },
    });

    renderChannelsPage();

    await screen.findByRole('button', { name: /WhatsApp/i });
    await waitFor(() => {
      expect(validateTokenMock).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole('button', { name: /WhatsApp/i }));
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'WhatsApp settings' }),
      ).toBeTruthy();
    });

    expect(
      (
        await screen.findByRole('img', { name: 'WhatsApp pairing QR' })
      ).textContent,
    ).toBe('▄▄\n██');
  });

  it('does not show email as active when the password is not configured', async () => {
    fetchConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config: makeConfig({
        email: {
          ...makeConfig().email,
          password: '',
        },
      }),
    });
    validateTokenMock.mockResolvedValue({
      status: 'ok',
      webAuthConfigured: true,
      version: 'test',
      imageTag: null,
      uptime: 1,
      sessions: 0,
      activeContainers: 0,
      defaultModel: 'gpt-5',
      ragDefault: true,
      timestamp: new Date().toISOString(),
      email: {
        passwordConfigured: false,
        passwordSource: null,
      },
      imessage: {
        passwordConfigured: false,
        passwordSource: null,
      },
      whatsapp: {
        linked: false,
        jid: null,
        pairingQrText: null,
        pairingUpdatedAt: null,
      },
    });

    renderChannelsPage();

    const emailButton = await screen.findByRole('button', { name: /Email/i });
    expect(emailButton.textContent || '').toContain('configured');
    expect(emailButton.textContent || '').not.toContain('active');
  });

  it('does not show remote iMessage as active when the password is not configured', async () => {
    fetchConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config: makeConfig({
        imessage: {
          ...makeConfig().imessage,
          enabled: true,
          backend: 'bluebubbles',
          serverUrl: 'https://bluebubbles.example.com',
          webhookPath: '/api/imessage/webhook',
        },
      }),
    });
    validateTokenMock.mockResolvedValue({
      status: 'ok',
      webAuthConfigured: true,
      version: 'test',
      imageTag: null,
      uptime: 1,
      sessions: 0,
      activeContainers: 0,
      defaultModel: 'gpt-5',
      ragDefault: true,
      timestamp: new Date().toISOString(),
      email: {
        passwordConfigured: true,
        passwordSource: 'config',
      },
      imessage: {
        passwordConfigured: false,
        passwordSource: null,
      },
      whatsapp: {
        linked: false,
        jid: null,
        pairingQrText: null,
        pairingUpdatedAt: null,
      },
    });

    renderChannelsPage();

    const imessageButton = await screen.findByRole('button', {
      name: /iMessage/i,
    });
    expect(imessageButton.textContent || '').toContain('available');
    expect(imessageButton.textContent || '').not.toContain('active');
  });

  it('shows partially set up iMessage as available instead of configured', async () => {
    fetchConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config: makeConfig({
        imessage: {
          ...makeConfig().imessage,
          enabled: true,
          cliPath: '',
        },
      }),
    });

    renderChannelsPage();

    const imessageButton = await screen.findByRole('button', {
      name: /iMessage/i,
    });
    expect(imessageButton.textContent || '').toContain('available');
    expect(imessageButton.textContent || '').not.toContain('configured');
  });

  it('turns Discord off through the top-level enabled toggle', async () => {
    const config = makeConfig();
    fetchConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config,
    });
    saveConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config: {
        ...config,
        discord: {
          ...config.discord,
          groupPolicy: 'disabled',
        },
      },
    });

    renderChannelsPage();

    await screen.findByRole('button', { name: /Discord/i });

    fireEvent.click(screen.getByRole('button', { name: /Discord/i }));
    const panel = screen
      .getByRole('heading', { name: 'Discord settings' })
      .closest('section');
    expect(panel).not.toBeNull();
    const enabledToggle = within(panel as HTMLElement).getByRole('group', {
      name: 'Enabled',
    });
    fireEvent.click(within(enabledToggle).getByRole('button', { name: 'off' }));
    fireEvent.click(
      within(panel as HTMLElement).getByRole('button', {
        name: 'Save channel settings',
      }),
    );

    await waitFor(() => {
      expect(saveConfigMock).toHaveBeenCalledWith(
        'test-token',
        expect.objectContaining({
          discord: expect.objectContaining({
            groupPolicy: 'disabled',
          }),
        }),
      );
    });
  });

  it('saves Discord command and send settings through the config endpoint', async () => {
    const config = makeConfig();
    fetchConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config,
    });
    saveConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config,
    });

    renderChannelsPage();

    await screen.findByRole('button', { name: /Discord/i });

    fireEvent.click(screen.getByRole('button', { name: /Discord/i }));
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Commands only' })).getByRole(
        'button',
        { name: 'on' },
      ),
    );
    fireEvent.change(screen.getByLabelText('Command mode'), {
      target: { value: 'restricted' },
    });
    fireEvent.change(screen.getByLabelText('Allowed command user IDs'), {
      target: { value: '123\n456' },
    });
    fireEvent.change(screen.getByLabelText('Send policy'), {
      target: { value: 'allowlist' },
    });
    fireEvent.change(screen.getByLabelText('Allowed outbound channel IDs'), {
      target: { value: '111,222' },
    });
    fireEvent.change(screen.getByLabelText('Free response channel IDs'), {
      target: { value: '333' },
    });
    fireEvent.change(screen.getByLabelText('Text chunk limit'), {
      target: { value: '1500' },
    });
    fireEvent.change(screen.getByLabelText('Max lines per message'), {
      target: { value: '25' },
    });
    fireEvent.click(
      within(
        screen.getByRole('group', { name: 'Remove ack after reply' }),
      ).getByRole('button', { name: 'off' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Save channel settings' }),
    );

    await waitFor(() => {
      expect(saveConfigMock).toHaveBeenCalledWith(
        'test-token',
        expect.objectContaining({
          discord: expect.objectContaining({
            commandsOnly: true,
            commandMode: 'restricted',
            commandAllowedUserIds: ['123', '456'],
            sendPolicy: 'allowlist',
            sendAllowedChannelIds: ['111', '222'],
            freeResponseChannels: ['333'],
            textChunkLimit: 1500,
            maxLinesPerMessage: 25,
            removeAckAfterReply: false,
          }),
        }),
      );
    });
  });

  it('turns WhatsApp off through the top-level enabled toggle', async () => {
    const config = makeConfig();
    fetchConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config,
    });
    saveConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config: {
        ...config,
        whatsapp: {
          ...config.whatsapp,
          dmPolicy: 'disabled',
          groupPolicy: 'disabled',
        },
      },
    });

    renderChannelsPage();

    await screen.findByRole('button', { name: /WhatsApp/i });

    fireEvent.click(screen.getByRole('button', { name: /WhatsApp/i }));
    const panel = screen
      .getByRole('heading', { name: 'WhatsApp settings' })
      .closest('section');
    expect(panel).not.toBeNull();
    const enabledToggle = within(panel as HTMLElement).getByRole('group', {
      name: 'Enabled',
    });
    fireEvent.click(within(enabledToggle).getByRole('button', { name: 'off' }));
    fireEvent.click(
      within(panel as HTMLElement).getByRole('button', {
        name: 'Save channel settings',
      }),
    );

    await waitFor(() => {
      expect(saveConfigMock).toHaveBeenCalledWith(
        'test-token',
        expect.objectContaining({
          whatsapp: expect.objectContaining({
            dmPolicy: 'disabled',
            groupPolicy: 'disabled',
          }),
        }),
      );
    });
  });

  it('updates email passwords through encrypted runtime secrets', async () => {
    fetchConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config: makeConfig({
        email: {
          ...makeConfig().email,
          password: '',
        },
      }),
    });
    setRuntimeSecretMock.mockResolvedValue({
      kind: 'plain',
      text: 'stored',
    });
    validateTokenMock.mockResolvedValue({
      status: 'ok',
      webAuthConfigured: true,
      version: 'test',
      imageTag: null,
      uptime: 1,
      sessions: 0,
      activeContainers: 0,
      defaultModel: 'gpt-5',
      ragDefault: true,
      timestamp: new Date().toISOString(),
      email: {
        passwordConfigured: true,
        passwordSource: 'runtime-secrets',
      },
      imessage: {
        passwordConfigured: false,
        passwordSource: null,
      },
      whatsapp: {
        linked: false,
        jid: null,
        pairingQrText: null,
        pairingUpdatedAt: null,
      },
    });
    useAuthMock.mockReturnValue({
      token: 'test-token',
      gatewayStatus: {
        email: {
          passwordConfigured: true,
          passwordSource: 'runtime-secrets',
        },
        imessage: {
          passwordConfigured: false,
          passwordSource: null,
        },
        whatsapp: {
          linked: false,
          jid: null,
          pairingQrText: null,
          pairingUpdatedAt: null,
        },
      },
    });

    renderChannelsPage();

    await screen.findByRole('button', { name: /Email/i });

    fireEvent.click(screen.getByRole('button', { name: /Email/i }));
    expect(screen.queryByLabelText('New password')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'replacement-secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save password' }));

    await waitFor(() => {
      expect(setRuntimeSecretMock).toHaveBeenCalledWith(
        'test-token',
        'EMAIL_PASSWORD',
        'replacement-secret',
      );
    });

    screen.getByText('Password updated in encrypted runtime secrets.');
  });

  it('updates Discord tokens through encrypted runtime secrets', async () => {
    fetchConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config: makeConfig(),
    });
    setRuntimeSecretMock.mockResolvedValue({
      kind: 'plain',
      text: 'stored',
    });
    validateTokenMock.mockResolvedValue({
      status: 'ok',
      webAuthConfigured: true,
      version: 'test',
      imageTag: null,
      uptime: 1,
      sessions: 0,
      activeContainers: 0,
      defaultModel: 'gpt-5',
      ragDefault: true,
      timestamp: new Date().toISOString(),
      discord: {
        tokenConfigured: true,
        tokenSource: 'runtime-secrets',
      },
      email: {
        passwordConfigured: false,
        passwordSource: null,
      },
      imessage: {
        passwordConfigured: false,
        passwordSource: null,
      },
      whatsapp: {
        linked: false,
        jid: null,
        pairingQrText: null,
        pairingUpdatedAt: null,
      },
    });
    useAuthMock.mockReturnValue({
      token: 'test-token',
      gatewayStatus: {
        discord: {
          tokenConfigured: true,
          tokenSource: 'runtime-secrets',
        },
        email: {
          passwordConfigured: false,
          passwordSource: null,
        },
        imessage: {
          passwordConfigured: false,
          passwordSource: null,
        },
        whatsapp: {
          linked: false,
          jid: null,
          pairingQrText: null,
          pairingUpdatedAt: null,
        },
      },
    });

    renderChannelsPage();

    await screen.findByRole('button', { name: /Discord/i });

    fireEvent.click(screen.getByRole('button', { name: /Discord/i }));
    expect(screen.queryByLabelText('New token')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Change token' }));
    fireEvent.change(screen.getByLabelText('New token'), {
      target: { value: 'replacement-token' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save token' }));

    await waitFor(() => {
      expect(setRuntimeSecretMock).toHaveBeenCalledWith(
        'test-token',
        'DISCORD_TOKEN',
        'replacement-token',
      );
    });

    screen.getByText('Bot token updated in encrypted runtime secrets.');
  });

  it('shows change password when passwordConfigured is true without a source', async () => {
    fetchConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config: makeConfig({
        email: {
          ...makeConfig().email,
          password: '',
        },
      }),
    });
    validateTokenMock.mockResolvedValue({
      status: 'ok',
      webAuthConfigured: true,
      version: 'test',
      imageTag: null,
      uptime: 1,
      sessions: 0,
      activeContainers: 0,
      defaultModel: 'gpt-5',
      ragDefault: true,
      timestamp: new Date().toISOString(),
      email: {
        passwordConfigured: true,
        passwordSource: null,
      },
      imessage: {
        passwordConfigured: false,
        passwordSource: null,
      },
      whatsapp: {
        linked: false,
        jid: null,
        pairingQrText: null,
        pairingUpdatedAt: null,
      },
    });

    renderChannelsPage();

    await screen.findByRole('button', { name: /Email/i });
    fireEvent.click(screen.getByRole('button', { name: /Email/i }));
    screen.getByRole('button', { name: 'Change password' });
    expect(screen.queryByRole('button', { name: 'Set password' })).toBeNull();
  });

  it('updates Telegram bot tokens through encrypted runtime secrets', async () => {
    fetchConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config: makeConfig({
        telegram: {
          ...makeConfig().telegram,
          enabled: true,
          dmPolicy: 'allowlist',
          botToken: '',
        },
      }),
    });
    setRuntimeSecretMock.mockResolvedValue({
      kind: 'plain',
      text: 'stored',
    });
    validateTokenMock.mockResolvedValue({
      status: 'ok',
      webAuthConfigured: true,
      version: 'test',
      imageTag: null,
      uptime: 1,
      sessions: 0,
      activeContainers: 0,
      defaultModel: 'gpt-5',
      ragDefault: true,
      timestamp: new Date().toISOString(),
      discord: {
        tokenConfigured: false,
        tokenSource: null,
      },
      telegram: {
        tokenConfigured: true,
        tokenSource: 'runtime-secrets',
      },
      email: {
        passwordConfigured: false,
        passwordSource: null,
      },
      imessage: {
        passwordConfigured: false,
        passwordSource: null,
      },
      whatsapp: {
        linked: false,
        jid: null,
        pairingQrText: null,
        pairingUpdatedAt: null,
      },
    });
    useAuthMock.mockReturnValue({
      token: 'test-token',
      gatewayStatus: {
        discord: {
          tokenConfigured: false,
          tokenSource: null,
        },
        telegram: {
          tokenConfigured: true,
          tokenSource: 'runtime-secrets',
        },
        email: {
          passwordConfigured: false,
          passwordSource: null,
        },
        imessage: {
          passwordConfigured: false,
          passwordSource: null,
        },
        whatsapp: {
          linked: false,
          jid: null,
          pairingQrText: null,
          pairingUpdatedAt: null,
        },
      },
    });

    renderChannelsPage();

    await screen.findByRole('button', { name: /Telegram/i });

    fireEvent.click(screen.getByRole('button', { name: /Telegram/i }));
    expect(screen.queryByLabelText('New token')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Change token' }));
    fireEvent.change(screen.getByLabelText('New token'), {
      target: { value: 'telegram-bot-token' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save token' }));

    await waitFor(() => {
      expect(setRuntimeSecretMock).toHaveBeenCalledWith(
        'test-token',
        'TELEGRAM_BOT_TOKEN',
        'telegram-bot-token',
      );
    });

    screen.getByText('Bot token updated in encrypted runtime secrets.');
  });
});
