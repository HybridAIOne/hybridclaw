import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdminAgent,
  AdminConfig,
  AdminConfigResponse,
} from '../api/types';
import { renderWithProviders } from '../test-utils';
import { ChannelsPage } from './channels';

const fetchAdminAgentsMock = vi.fn<() => Promise<AdminAgent[]>>();
const fetchConfigMock = vi.fn<() => Promise<AdminConfigResponse>>();
const fetchEmailConfigMock = vi.fn();
const fetchSignalLinkMock = vi.fn();
const saveConfigMock = vi.fn();
const saveDiscordWebhookTargetMock = vi.fn();
const saveSlackWebhookTargetMock = vi.fn();
const setRuntimeSecretMock = vi.fn();
const startSignalLinkMock = vi.fn();
const validateTokenMock = vi.fn();
const useAuthMock = vi.fn();

vi.mock('../api/client', () => ({
  fetchAdminAgents: () => fetchAdminAgentsMock(),
  fetchConfig: () => fetchConfigMock(),
  fetchEmailConfig: (...args: unknown[]) => fetchEmailConfigMock(...args),
  fetchSignalLink: (...args: unknown[]) => fetchSignalLinkMock(...args),
  saveConfig: (...args: unknown[]) => saveConfigMock(...args),
  saveDiscordWebhookTarget: (...args: unknown[]) =>
    saveDiscordWebhookTargetMock(...args),
  saveSlackWebhookTarget: (...args: unknown[]) =>
    saveSlackWebhookTargetMock(...args),
  setRuntimeSecret: (...args: unknown[]) => setRuntimeSecretMock(...args),
  startSignalLink: (...args: unknown[]) => startSignalLinkMock(...args),
  validateToken: (...args: unknown[]) => validateTokenMock(...args),
}));

vi.mock('../auth', () => ({
  useAuth: () => useAuthMock(),
}));

function makeConfig(overrides: Partial<AdminConfig> = {}): AdminConfig {
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
      voice:
        'This is a live phone call. Produce plain spoken text only.\nKeep each reply short and conversational, usually one or two short sentences.',
      whatsapp: '',
      email: '',
      imessage: '',
      line: '',
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
      tab: {
        enabled: false,
        ssoAppId: '',
        appIdUri: '',
        allowFrom: [],
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
    slackWebhook: {
      enabled: false,
      webhooks: {},
    },
    discordWebhook: {
      enabled: false,
      webhooks: {},
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
    signal: {
      enabled: false,
      daemonUrl: 'http://127.0.0.1:8080',
      account: '',
      dmPolicy: 'allowlist',
      groupPolicy: 'disabled',
      allowFrom: [],
      groupAllowFrom: [],
      textChunkLimit: 4000,
      reconnectIntervalMs: 5000,
      outboundDelayMs: 350,
    },
    threema: {
      enabled: false,
      apiBaseUrl: 'https://msgapi.threema.ch',
      identity: '',
      secret: '',
      dmPolicy: 'allowlist',
      allowFrom: [],
      textChunkLimit: 3500,
      outboundDelayMs: 350,
    },
    voice: {
      enabled: false,
      provider: 'twilio',
      twilio: {
        accountSid: '',
        authToken: '',
        fromNumber: '',
      },
      relay: {
        ttsProvider: 'default',
        voice: '',
        transcriptionProvider: 'default',
        language: 'en-US',
        interruptible: true,
        welcomeGreeting: 'Hello! How can I help you today?',
      },
      webhookPath: '/voice',
      maxConcurrentCalls: 8,
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
    line: {
      enabled: false,
      textChunkLimit: 5000,
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
      accounts: [],
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
      persistBashState: true,
    },
    deployment: {
      mode: 'local',
      public_url: '',
      tunnel: {
        provider: 'manual',
        health_check_interval_ms: 30000,
      },
    },
    ops: {
      healthHost: '127.0.0.1',
      healthPort: 3001,
      webApiToken: 'token',
      gatewayBaseUrl: 'http://localhost:3000',
      gatewayInternalBaseUrl: 'http://127.0.0.1:3000',
      gatewayApiToken: 'token',
      dbPath: '/tmp/hybridclaw.db',
      logLevel: 'info',
    },
    ...overrides,
  };
}

function makeAgent(overrides: Partial<AdminAgent> = {}): AdminAgent {
  return {
    id: 'main',
    name: 'Main',
    model: 'gpt-5',
    skills: [],
    chatbotId: null,
    enableRag: true,
    proxy: null,
    role: null,
    reportsTo: null,
    delegatesTo: null,
    peers: null,
    workspace: null,
    workspacePath: '/tmp/main-agent',
    markdownFiles: [],
    ...overrides,
  };
}

function renderChannelsPage(): void {
  renderWithProviders(<ChannelsPage />);
}

describe('ChannelsPage', () => {
  beforeEach(() => {
    fetchAdminAgentsMock.mockReset();
    fetchConfigMock.mockReset();
    fetchEmailConfigMock.mockReset();
    fetchSignalLinkMock.mockReset();
    saveConfigMock.mockReset();
    saveDiscordWebhookTargetMock.mockReset();
    saveSlackWebhookTargetMock.mockReset();
    setRuntimeSecretMock.mockReset();
    startSignalLinkMock.mockReset();
    validateTokenMock.mockReset();
    useAuthMock.mockReset();
    fetchAdminAgentsMock.mockResolvedValue([]);
    const gatewayStatus = {
      hybridai: {
        apiKeyConfigured: false,
        apiKeySource: null,
      },
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
      signal: {
        enabled: false,
        daemonUrlConfigured: true,
        accountConfigured: false,
        pairingStatus: 'idle',
        pairingQrText: null,
        pairingUri: null,
        pairingUpdatedAt: null,
        pairingError: null,
        cliAvailable: true,
        cliPath: 'signal-cli',
        cliVersion: 'signal-cli 0.14.2',
        cliError: null,
      },
      voice: {
        enabled: false,
        accountSidConfigured: false,
        fromNumberConfigured: false,
        authTokenConfigured: false,
        authTokenSource: null,
        webhookPath: '/voice',
        maxConcurrentCalls: 8,
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
    fetchSignalLinkMock.mockResolvedValue({
      status: 'idle',
      pairingQrText: null,
      pairingUri: null,
      updatedAt: null,
      error: null,
    });
  });

  afterEach(() => {
    window.history.replaceState(null, '', '/');
    vi.clearAllMocks();
  });

  it('lists configured transports instead of an explicit binding empty state', async () => {
    fetchConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config: makeConfig(),
    });

    renderChannelsPage();

    await screen.findByRole('button', {
      name: /^Discord(?! Incoming Webhook)/i,
    });
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

    const [emailChannelButton] = await screen.findAllByRole('button', {
      name: /Email/i,
    });

    fireEvent.click(emailChannelButton);
    fireEvent.change(screen.getByLabelText('Default mailbox address'), {
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

  it('links Microsoft Teams settings to Teams app setup', async () => {
    fetchConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config: makeConfig(),
    });

    renderChannelsPage();

    fireEvent.click(
      await screen.findByRole('button', { name: /Microsoft Teams/i }),
    );

    screen.getByText(/Paste values from Microsoft Entra Admin Center/i);
    screen.getByText(
      'Application (client) ID from the Entra app registration.',
    );
    screen.getByText('Directory (tenant) ID from the same Entra tenant.');
    expect(screen.queryByText('Team defaults')).toBeNull();
    expect(screen.queryByText('Channel overrides')).toBeNull();
    const advancedSettings = screen
      .getByText('Advanced delivery settings')
      .closest('details') as HTMLDetailsElement | null;
    expect(advancedSettings?.open).toBe(false);
    const appSetupLink = screen.getByRole('link', { name: 'App Setup' });
    expect(appSetupLink.getAttribute('href')).toBe('/admin/teams');
    const setupInstructions = screen
      .getByText('Teams app setup instructions')
      .closest('details') as HTMLDetailsElement | null;
    expect(setupInstructions?.open).toBe(false);
    screen.getByText(/Cloud deployments should already show/i);
    screen.getByText(/Local installs need a public HTTPS tunnel/i);
    screen.getByText(/add an `access_as_user` scope/i);
    screen.getByText(/Authorized client applications/i);
    screen.getByText(/use Apps, Share, Add to Teams/i);
  });

  it('shows the target agent for the default email mailbox', async () => {
    const config = makeConfig();
    fetchConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config,
    });
    fetchAdminAgentsMock.mockResolvedValue([
      makeAgent({ id: 'main', name: 'Main Agent' }),
    ]);

    renderChannelsPage();

    const [emailChannelButton] = await screen.findAllByRole('button', {
      name: /Email/i,
    });

    fireEvent.click(emailChannelButton);

    screen.getByText(/Default agent mailbox:/);
    screen.getByText('Main Agent (main)');
    screen.getByText(
      'Inbound target; outbound fallback for agents without an additional mailbox.',
    );
  });

  it('collapses email advanced settings above additional mailboxes by default', async () => {
    const config = makeConfig({
      channelInstructions: {
        ...makeConfig().channelInstructions,
        email: 'Use concise email replies.',
      },
    });
    fetchConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config,
    });

    renderChannelsPage();

    const [emailChannelButton] = await screen.findAllByRole('button', {
      name: /Email/i,
    });

    fireEvent.click(emailChannelButton);

    const summary = screen.getByText('Advanced settings');
    const details = summary.closest('details') as HTMLDetailsElement | null;
    if (!details) throw new Error('Expected advanced settings details.');
    expect(details.open).toBe(false);

    const additionalMailboxes = screen.getByText('Additional agent mailboxes');
    expect(
      Boolean(
        details.compareDocumentPosition(additionalMailboxes) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);

    fireEvent.click(summary);

    expect(details.open).toBe(true);
    expect(within(details).getByLabelText('Poll interval ms')).toBeTruthy();
    expect(within(details).getByLabelText('Text chunk limit')).toBeTruthy();
    expect(within(details).getByLabelText('Media max MB')).toBeTruthy();
    expect(
      (
        within(details).getByLabelText(
          'Channel instructions',
        ) as HTMLTextAreaElement
      ).value,
    ).toBe('Use concise email replies.');
  });

  it('saves email channel settings immediately when adding an allowed sender', async () => {
    const config = makeConfig();
    const savedConfig = {
      ...config,
      email: {
        ...config.email,
        allowFrom: ['ops@example.com', 'new@example.com'],
      },
    };
    fetchConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config,
    });
    saveConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config: savedConfig,
    });

    renderChannelsPage();

    const [emailChannelButton] = await screen.findAllByRole('button', {
      name: /Email/i,
    });

    fireEvent.click(emailChannelButton);
    fireEvent.change(screen.getByLabelText('Allowed senders'), {
      target: { value: 'new@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      expect(saveConfigMock).toHaveBeenCalledTimes(1);
    });

    expect(saveConfigMock).toHaveBeenCalledWith(
      'test-token',
      expect.objectContaining({
        email: expect.objectContaining({
          allowFrom: ['ops@example.com', 'new@example.com'],
        }),
      }),
    );
  });

  it('saves agent mailbox mappings through the email channel editor', async () => {
    const config = makeConfig();
    fetchConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config,
    });
    fetchAdminAgentsMock.mockResolvedValue([
      makeAgent({ id: 'support', name: 'Support Agent' }),
    ]);
    saveConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config,
    });

    renderChannelsPage();

    const [emailChannelButton] = await screen.findAllByRole('button', {
      name: /Email/i,
    });

    fireEvent.click(emailChannelButton);
    fireEvent.click(
      screen.getByRole('button', { name: 'Add additional mailbox' }),
    );

    await screen.findByRole('option', {
      name: 'Support Agent (support)',
    });

    fireEvent.change(screen.getByLabelText('Agent'), {
      target: { value: 'support' },
    });
    fireEvent.change(screen.getByLabelText('Mailbox address'), {
      target: { value: 'support@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Password SecretRef id'), {
      target: { value: 'SUPPORT_EMAIL_PASSWORD' },
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
          accounts: [
            expect.objectContaining({
              agentId: 'support',
              address: 'support@example.com',
              password: {
                source: 'store',
                id: 'SUPPORT_EMAIL_PASSWORD',
              },
              imapHost: 'imap.example.com',
              smtpHost: 'smtp.example.com',
              folders: ['INBOX'],
              allowFrom: ['ops@example.com'],
            }),
          ],
        }),
      }),
    );
  });

  it('loads HybridAI mailbox config into an additional agent mailbox row', async () => {
    const config = makeConfig();
    fetchConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config,
    });
    fetchAdminAgentsMock.mockResolvedValue([
      makeAgent({
        id: 'support',
        name: 'Support Agent',
        chatbotId: 'support-bot',
      }),
    ]);
    fetchEmailConfigMock.mockResolvedValue({
      handles: [{ id: 'support-bot', handle: 'support', status: 'active' }],
      handleId: 'support-bot',
      credentials: {
        email: 'support@example.com',
        password: 'support-password',
        imap_host: 'imap.hybridai.example',
        imap_port: 993,
        smtp_host: 'smtp.hybridai.example',
        smtp_port: 587,
      },
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
      hybridai: {
        apiKeyConfigured: true,
        apiKeySource: 'runtime-secrets',
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
        hybridai: {
          apiKeyConfigured: true,
          apiKeySource: 'runtime-secrets',
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

    const [emailChannelButton] = await screen.findAllByRole('button', {
      name: /Email/i,
    });

    fireEvent.click(emailChannelButton);
    fireEvent.click(
      screen.getByRole('button', { name: 'Add additional mailbox' }),
    );

    await screen.findByRole('option', {
      name: 'Support Agent (support)',
    });

    fireEvent.change(screen.getByLabelText('Agent'), {
      target: { value: 'support' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Fetch HybridAI mailbox' }),
    );

    await waitFor(() => {
      expect(fetchEmailConfigMock).toHaveBeenCalledWith('test-token', {
        handleId: 'support-bot',
      });
    });
    expect(setRuntimeSecretMock).toHaveBeenCalledWith(
      'test-token',
      'SUPPORT_1AQ2GZ1_EMAIL_PASSWORD',
      'support-password',
    );
    screen.getByDisplayValue('support@example.com');
    screen.getByDisplayValue('SUPPORT_1AQ2GZ1_EMAIL_PASSWORD');
    screen.getByDisplayValue('imap.hybridai.example');
    screen.getByDisplayValue('smtp.hybridai.example');
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
      name: /^Discord(?! Incoming Webhook)/i,
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

    const slackButton = (
      await screen.findAllByRole('button', {
        name: /Slack/i,
      })
    ).find((button) =>
      within(button).queryByText('Slack', { selector: 'strong' }),
    );
    if (!slackButton) throw new Error('Slack button not found.');
    expect(slackButton.textContent || '').toContain('active');

    fireEvent.click(slackButton);
    expect(
      screen.getByRole('heading', { name: 'Slack settings' }),
    ).toBeTruthy();
    expect(screen.getByText('Bot token')).toBeTruthy();
    expect(screen.getByText('App token')).toBeTruthy();
  });

  it('rotates Slack webhook targets without keeping the URL in the draft', async () => {
    const config = makeConfig({
      slackWebhook: {
        enabled: true,
        webhooks: {
          default: {
            webhookUrl: '',
            defaultUsername: 'HybridClaw',
            defaultIconEmoji: '',
            defaultIconUrl: '',
          },
        },
      },
    });
    const savedConfig = makeConfig({
      slackWebhook: {
        enabled: true,
        webhooks: {
          default: {
            webhookUrl: '',
            defaultUsername: 'HybridClaw',
            defaultIconEmoji: ':robot_face:',
            defaultIconUrl: '',
          },
        },
      },
    });
    fetchConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config,
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
      slackWebhook: {
        targetCount: 1,
        defaultTargetConfigured: true,
        lastReachabilityResults: [],
        lastSendResults: [],
      },
    });
    saveSlackWebhookTargetMock.mockResolvedValue({
      path: '/tmp/config.json',
      config: savedConfig,
    });

    renderChannelsPage();

    const webhookButton = await screen.findByRole('button', {
      name: /Slack Incoming Webhook/i,
    });
    fireEvent.click(webhookButton);
    fireEvent.change(screen.getByLabelText('Webhook URL'), {
      target: {
        value: 'https://hooks.slack.com/services/T000/B000/SECRET',
      },
    });
    fireEvent.change(screen.getByLabelText('Icon emoji'), {
      target: { value: ':robot_face:' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Save webhook target' }),
    );

    await waitFor(() => {
      expect(saveSlackWebhookTargetMock).toHaveBeenCalledWith('test-token', {
        target: 'default',
        webhookUrl: 'https://hooks.slack.com/services/T000/B000/SECRET',
        defaultUsername: 'HybridClaw',
        defaultIconEmoji: ':robot_face:',
        defaultIconUrl: '',
      });
    });
    await waitFor(() => {
      expect(
        (screen.getByLabelText('Webhook URL') as HTMLInputElement).value,
      ).toBe('');
    });
    expect(screen.queryByDisplayValue(/SECRET/)).toBeNull();
  });

  it('rotates Discord webhook targets without keeping the URL in the draft', async () => {
    const config = makeConfig({
      discordWebhook: {
        enabled: true,
        webhooks: {
          default: {
            webhookUrl: '',
            defaultUsername: 'HybridClaw',
            defaultAvatarUrl: '',
          },
        },
      },
    });
    const savedConfig = makeConfig({
      discordWebhook: {
        enabled: true,
        webhooks: {
          default: {
            webhookUrl: '',
            defaultUsername: 'HybridClaw',
            defaultAvatarUrl: 'https://example.com/avatar.png',
          },
        },
      },
    });
    fetchConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config,
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
      discordWebhook: {
        targetCount: 1,
        defaultTargetConfigured: true,
        lastReachabilityResults: [],
        lastSendResults: [],
      },
    });
    saveDiscordWebhookTargetMock.mockResolvedValue({
      path: '/tmp/config.json',
      config: savedConfig,
    });

    renderChannelsPage();

    const webhookButton = await screen.findByRole('button', {
      name: /Discord Incoming Webhook/i,
    });
    fireEvent.click(webhookButton);
    fireEvent.change(screen.getByLabelText('Webhook URL'), {
      target: {
        value: 'https://discord.com/api/webhooks/123/TOKEN',
      },
    });
    fireEvent.change(screen.getByLabelText('Avatar URL'), {
      target: { value: 'https://example.com/avatar.png' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Save webhook target' }),
    );

    await waitFor(() => {
      expect(saveDiscordWebhookTargetMock).toHaveBeenCalledWith('test-token', {
        target: 'default',
        webhookUrl: 'https://discord.com/api/webhooks/123/TOKEN',
        defaultUsername: 'HybridClaw',
        defaultAvatarUrl: 'https://example.com/avatar.png',
      });
    });
    await waitFor(() => {
      expect(
        (screen.getByLabelText('Webhook URL') as HTMLInputElement).value,
      ).toBe('');
    });
    expect(screen.queryByDisplayValue(/TOKEN/)).toBeNull();
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
      name: /^Discord(?! Incoming Webhook)/i,
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

  it('shows Signal as active when enabled with daemon and account configured', async () => {
    fetchConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config: makeConfig({
        signal: {
          ...makeConfig().signal,
          enabled: true,
          account: '+14155550123',
          dmPolicy: 'allowlist',
          allowFrom: ['+14155551212'],
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
      signal: {
        enabled: true,
        daemonUrlConfigured: true,
        accountConfigured: true,
        pairingStatus: 'idle',
        pairingQrText: null,
        pairingUri: null,
        pairingUpdatedAt: null,
        pairingError: null,
        cliAvailable: true,
        cliPath: 'signal-cli',
        cliVersion: 'signal-cli 0.14.2',
        cliError: null,
      },
    });

    renderChannelsPage();

    const signalButton = await screen.findByRole('button', { name: /Signal/i });
    expect(signalButton.textContent || '').toContain('active');
    fireEvent.click(signalButton);
    expect(
      screen.getByRole('heading', { name: 'Signal settings' }),
    ).toBeTruthy();
    expect(screen.getByLabelText('Daemon URL')).toBeTruthy();
    expect(screen.getByLabelText('Account')).toBeTruthy();
    expect(screen.getByLabelText('Channel instructions')).toBeTruthy();
  });

  it('saves Signal setup through the config endpoint', async () => {
    const config = makeConfig();
    fetchConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config,
    });
    saveConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config: {
        ...config,
        signal: {
          ...config.signal,
          enabled: true,
          daemonUrl: 'http://127.0.0.1:8080',
          account: '+14155550123',
          dmPolicy: 'allowlist',
          allowFrom: ['+14155551212', '+14155559876'],
        },
      },
    });

    renderChannelsPage();

    await screen.findByRole('button', { name: /Signal/i });
    fireEvent.click(screen.getByRole('button', { name: /Signal/i }));

    const panel = screen
      .getByRole('heading', { name: 'Signal settings' })
      .closest('[data-slot="card"]');
    expect(panel).not.toBeNull();

    fireEvent.click(
      within(panel as HTMLElement).getByRole('switch', { name: 'Enabled' }),
    );
    fireEvent.change(screen.getByLabelText('Daemon URL'), {
      target: { value: 'http://127.0.0.1:8080' },
    });
    fireEvent.change(screen.getByLabelText('Account'), {
      target: { value: '+14155550123' },
    });
    fireEvent.change(screen.getByLabelText('DM policy'), {
      target: { value: 'allowlist' },
    });
    const addDmSenderButton = within(panel as HTMLElement).getAllByRole(
      'button',
      {
        name: 'Add',
      },
    )[0] as HTMLElement;
    fireEvent.change(screen.getByLabelText('Allowed DM senders'), {
      target: { value: '+14155551212' },
    });
    fireEvent.click(addDmSenderButton);
    fireEvent.change(screen.getByLabelText('Allowed DM senders'), {
      target: { value: '+14155551212' },
    });
    fireEvent.click(addDmSenderButton);
    fireEvent.change(screen.getByLabelText('Allowed DM senders'), {
      target: { value: '+14155559876' },
    });
    fireEvent.click(addDmSenderButton);
    fireEvent.click(
      within(panel as HTMLElement).getByRole('button', {
        name: 'Save channel settings',
      }),
    );

    await waitFor(() => {
      expect(saveConfigMock).toHaveBeenCalledWith(
        'test-token',
        expect.objectContaining({
          signal: expect.objectContaining({
            enabled: true,
            daemonUrl: 'http://127.0.0.1:8080',
            account: '+14155550123',
            dmPolicy: 'allowlist',
            allowFrom: ['+14155551212', '+14155559876'],
          }),
        }),
      );
    });
  });

  it('confirms and labels wildcard Signal allowlist entries', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fetchConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config: makeConfig({
        signal: {
          ...makeConfig().signal,
          enabled: true,
          account: '+14155550123',
          dmPolicy: 'allowlist',
        },
      }),
    });

    renderChannelsPage();

    await screen.findByRole('button', { name: /Signal/i });
    fireEvent.click(screen.getByRole('button', { name: /Signal/i }));

    const panel = screen
      .getByRole('heading', { name: 'Signal settings' })
      .closest('[data-slot="card"]');
    expect(panel).not.toBeNull();

    const addDmSenderButton = within(panel as HTMLElement).getAllByRole(
      'button',
      {
        name: 'Add',
      },
    )[0] as HTMLElement;
    fireEvent.change(screen.getByLabelText('Allowed DM senders'), {
      target: { value: '*' },
    });
    fireEvent.click(addDmSenderButton);

    expect(confirmSpy).toHaveBeenCalledWith(
      'Adding * allows every sender for this allowlist. Continue?',
    );
    expect(within(panel as HTMLElement).getByText('*')).toBeTruthy();
    expect(within(panel as HTMLElement).getByText('all senders')).toBeTruthy();

    confirmSpy.mockRestore();
  });

  it('starts Signal linked-device setup and renders the QR', async () => {
    fetchConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config: makeConfig(),
    });
    startSignalLinkMock.mockResolvedValue({
      status: 'qr',
      pairingQrText: '▄▄\n██',
      pairingUri: 'sgnl://linkdevice?uuid=abc&pub_key=def',
      updatedAt: new Date().toISOString(),
      error: null,
    });

    renderChannelsPage();

    await screen.findByRole('button', { name: /Signal/i });
    fireEvent.click(screen.getByRole('button', { name: /Signal/i }));

    fireEvent.change(screen.getByLabelText('signal-cli path'), {
      target: { value: '/usr/local/bin/signal-cli' },
    });
    fireEvent.change(screen.getByLabelText('Device name'), {
      target: { value: 'HybridClaw Cloud' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start QR link' }));

    await waitFor(() => {
      expect(startSignalLinkMock).toHaveBeenCalledWith('test-token', {
        cliPath: '/usr/local/bin/signal-cli',
        deviceName: 'HybridClaw Cloud',
      });
    });
    expect(
      (await screen.findByRole('img', { name: 'Signal linked-device QR' }))
        .textContent,
    ).toBe('▄▄\n██');
  });

  it('disables Signal linked-device setup when signal-cli is unavailable', async () => {
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
      signal: {
        enabled: false,
        daemonUrlConfigured: false,
        accountConfigured: false,
        pairingStatus: 'idle',
        pairingQrText: null,
        pairingUri: null,
        pairingUpdatedAt: null,
        pairingError: null,
        cliAvailable: false,
        cliPath: 'signal-cli',
        cliVersion: null,
        cliError: 'spawn signal-cli ENOENT',
      },
    });

    renderChannelsPage();

    await screen.findByRole('button', { name: /Signal/i });
    fireEvent.click(screen.getByRole('button', { name: /Signal/i }));

    expect(
      (
        screen.getByRole('button', {
          name: 'Start QR link',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      screen.getByText(/signal-cli is not available on this gateway host/i),
    ).toBeTruthy();
  });

  it('shows Voice in the catalog and opens the Twilio voice editor', async () => {
    const baseConfig = makeConfig();
    fetchConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config: makeConfig({
        voice: {
          ...baseConfig.voice,
          enabled: true,
          twilio: {
            ...baseConfig.voice.twilio,
            accountSid: 'AC123',
            fromNumber: '+14155550123',
          },
        },
      }),
    });

    renderChannelsPage();

    const voiceButton = await screen.findByRole('button', { name: /Voice/i });
    expect(voiceButton.textContent || '').toContain('configured');

    fireEvent.click(voiceButton);
    expect(
      screen.getByRole('heading', { name: 'Voice settings' }),
    ).toBeTruthy();
    expect(screen.getByText('Twilio auth token')).toBeTruthy();
    expect(screen.getByLabelText('Twilio account SID')).toBeTruthy();
    expect(screen.getByLabelText('Webhook path')).toBeTruthy();
    expect(screen.getByLabelText('Channel instructions')).toBeTruthy();
  });

  it('saves channel-specific instructions through the config endpoint', async () => {
    const config = makeConfig();

    fetchConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config,
    });
    saveConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config: {
        ...config,
        channelInstructions: {
          ...config.channelInstructions,
          voice: 'Answer in one short sentence. No formatting.',
        },
      },
    });

    renderChannelsPage();

    await screen.findByRole('button', { name: /Voice/i });

    fireEvent.click(screen.getByRole('button', { name: /Voice/i }));
    fireEvent.change(screen.getByLabelText('Channel instructions'), {
      target: { value: 'Answer in one short sentence. No formatting.' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Save channel settings' }),
    );

    await waitFor(() => {
      expect(saveConfigMock).toHaveBeenCalledWith(
        'test-token',
        expect.objectContaining({
          channelInstructions: expect.objectContaining({
            voice: 'Answer in one short sentence. No formatting.',
          }),
        }),
      );
    });
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
        pairingError: null,
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
      (await screen.findByRole('img', { name: 'WhatsApp pairing QR' }))
        .textContent,
    ).toBe('▄▄\n██');
  });

  it('renders the WhatsApp pairing error when the gateway has no QR', async () => {
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
        pairingQrText: null,
        pairingUpdatedAt: '2026-06-13T21:00:00.000Z',
        pairingError:
          'WhatsApp WebSocket DNS lookup failed for web.whatsapp.com. Retrying connection in 1s.',
      },
    });

    renderChannelsPage();

    await screen.findByRole('button', { name: /WhatsApp/i });
    fireEvent.click(screen.getByRole('button', { name: /WhatsApp/i }));

    expect(
      await screen.findByText(
        'WhatsApp WebSocket DNS lookup failed for web.whatsapp.com. Retrying connection in 1s.',
      ),
    ).toBeTruthy();
  });

  it('selects WhatsApp settings from the whatsapp hash fragment', async () => {
    window.history.replaceState(null, '', '/admin/channels#whatsapp');
    fetchConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config: makeConfig(),
    });

    renderChannelsPage();

    await screen.findByRole('button', { name: /WhatsApp/i });

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'WhatsApp settings' }),
      ).toBeTruthy();
    });
  });

  it('selects Telegram settings from the telegram hash fragment', async () => {
    window.history.replaceState(null, '', '/admin/channels#telegram');
    fetchConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config: makeConfig(),
    });

    renderChannelsPage();

    await screen.findByRole('button', { name: /Telegram/i });

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Telegram settings' }),
      ).toBeTruthy();
    });
  });

  it('selects Discord settings from the discord hash fragment', async () => {
    window.history.replaceState(null, '', '/admin/channels#discord');
    fetchConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config: makeConfig(),
    });

    renderChannelsPage();

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Discord settings' }),
      ).toBeTruthy();
    });
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

    await screen.findByRole('button', {
      name: /^Discord(?! Incoming Webhook)/i,
    });

    fireEvent.click(
      screen.getByRole('button', {
        name: /^Discord(?! Incoming Webhook)/i,
      }),
    );
    const panel = screen
      .getByRole('heading', { name: 'Discord settings' })
      .closest('[data-slot="card"]');
    expect(panel).not.toBeNull();
    fireEvent.click(
      within(panel as HTMLElement).getByRole('switch', { name: 'Enabled' }),
    );
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

    await screen.findByRole('button', {
      name: /^Discord(?! Incoming Webhook)/i,
    });

    fireEvent.click(
      screen.getByRole('button', {
        name: /^Discord(?! Incoming Webhook)/i,
      }),
    );
    fireEvent.click(screen.getByRole('switch', { name: 'Commands only' }));
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
      screen.getByRole('switch', { name: 'Remove ack after reply' }),
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
    const panel = (
      await screen.findByRole('heading', {
        name: 'WhatsApp settings',
      })
    ).closest('[data-slot="card"]');
    expect(panel).not.toBeNull();
    fireEvent.click(
      within(panel as HTMLElement).getByRole('switch', { name: 'Enabled' }),
    );
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

    screen.getByText(
      'Default mailbox password updated in encrypted runtime secrets.',
    );
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

    await screen.findByRole('button', {
      name: /^Discord(?! Incoming Webhook)/i,
    });

    fireEvent.click(
      screen.getByRole('button', {
        name: /^Discord(?! Incoming Webhook)/i,
      }),
    );
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

    const [emailChannelButton] = await screen.findAllByRole('button', {
      name: /Email/i,
    });
    fireEvent.click(emailChannelButton);
    screen.getByRole('button', { name: 'Change password' });
    expect(screen.queryByRole('button', { name: 'Set password' })).toBeNull();
  });

  it('hides fetch email config when no HybridAI API key is configured', async () => {
    fetchConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config: makeConfig(),
    });

    renderChannelsPage();

    const [emailChannelButton] = await screen.findAllByRole('button', {
      name: /Email/i,
    });
    fireEvent.click(emailChannelButton);

    expect(
      screen.queryByRole('button', { name: 'Fetch HybridAI Agent Email' }),
    ).toBeNull();
  });

  it('shows fetch email config when a HybridAI API key is configured', async () => {
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
      hybridai: {
        apiKeyConfigured: true,
        apiKeySource: 'runtime-secrets',
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
        hybridai: {
          apiKeyConfigured: true,
          apiKeySource: 'runtime-secrets',
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

    const [emailChannelButton] = await screen.findAllByRole('button', {
      name: /Email/i,
    });
    fireEvent.click(emailChannelButton);

    expect(
      screen.getByRole('button', { name: 'Fetch HybridAI Agent Email' }),
    ).toBeTruthy();
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
