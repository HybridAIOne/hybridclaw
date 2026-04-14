import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AdminChannelsResponse,
  AdminConfig,
  AdminConfigResponse,
  AdminSchedulerJob,
  AdminSchedulerResponse,
  GatewayStatus,
} from '../api/types';
import { ToastProvider } from '../components/toast';
import { normalizeSchedulerAtInput, SchedulerPage } from './scheduler';

const fetchChannelsMock = vi.fn<() => Promise<AdminChannelsResponse>>();
const fetchConfigMock = vi.fn<() => Promise<AdminConfigResponse>>();
const fetchSchedulerMock = vi.fn<() => Promise<AdminSchedulerResponse>>();
const saveSchedulerJobMock = vi.fn();
const deleteSchedulerJobMock = vi.fn();
const setSchedulerJobPausedMock = vi.fn();
const useAuthMock = vi.fn();

vi.mock('../api/client', () => ({
  fetchChannels: () => fetchChannelsMock(),
  fetchConfig: () => fetchConfigMock(),
  fetchScheduler: () => fetchSchedulerMock(),
  saveSchedulerJob: (...args: unknown[]) => saveSchedulerJobMock(...args),
  deleteSchedulerJob: (...args: unknown[]) => deleteSchedulerJobMock(...args),
  setSchedulerJobPaused: (...args: unknown[]) =>
    setSchedulerJobPausedMock(...args),
}));

vi.mock('../auth', () => ({
  useAuth: () => useAuthMock(),
}));

function makeStatus(overrides: Partial<GatewayStatus> = {}): GatewayStatus {
  return {
    status: 'ok',
    webAuthConfigured: true,
    pid: 1234,
    version: '0.12.3',
    imageTag: null,
    uptime: 120,
    sessions: 3,
    activeContainers: 1,
    defaultModel: 'gpt-5',
    ragDefault: true,
    timestamp: '2026-04-12T16:00:00.000Z',
    lifecycle: {
      restartSupported: true,
      restartReason: null,
    },
    providerHealth: {},
    scheduler: { jobs: [] },
    sandbox: {
      mode: 'container',
      activeSessions: 1,
      warning: null,
    },
    codex: {
      authenticated: true,
      source: 'browser-pkce',
      accountId: 'acct',
      expiresAt: null,
      reloginRequired: false,
    },
    observability: {
      enabled: false,
      running: false,
      paused: false,
      reason: null,
      streamKey: null,
      lastCursor: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
    },
    discord: {
      tokenConfigured: true,
      tokenSource: 'runtime-secrets',
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
    ...overrides,
  } as GatewayStatus;
}

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
    channelInstructions: {
      discord: '',
      msteams: '',
      slack: '',
      telegram: '',
      voice:
        'This is a live phone call. Produce plain spoken text only.\nKeep each reply short and conversational, usually one or two short sentences.',
      whatsapp: '',
      email: '',
      imessage: '',
    },
    discord: {
      commandsOnly: false,
      groupPolicy: 'open',
      guilds: {},
    },
    slack: {
      enabled: false,
      groupPolicy: 'disabled',
      dmPolicy: 'disabled',
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
      dmPolicy: 'disabled',
      groupPolicy: 'disabled',
      allowFrom: [],
      groupAllowFrom: [],
      textChunkLimit: 4000,
      debounceMs: 2500,
      sendReadReceipts: true,
      ackReaction: '👀',
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
      allowFrom: [],
      textChunkLimit: 50000,
      mediaMaxMb: 20,
    },
    msteams: {
      enabled: false,
      appId: '',
      tenantId: '',
      webhook: {
        port: 3978,
        path: '/api/msteams/messages',
      },
      groupPolicy: 'disabled',
      dmPolicy: 'disabled',
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
      dmPolicy: 'disabled',
      groupPolicy: 'disabled',
      allowFrom: [],
      groupAllowFrom: [],
      textChunkLimit: 4000,
      debounceMs: 2500,
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
  } as AdminConfig;
}

function makeChannelsResponse(
  overrides: Partial<AdminChannelsResponse> = {},
): AdminChannelsResponse {
  return {
    groupPolicy: 'open',
    defaultTypingMode: 'thinking',
    defaultDebounceMs: 2500,
    defaultAckReaction: '👀',
    defaultRateLimitPerUser: 0,
    defaultMaxConcurrentPerChannel: 2,
    slack: {
      enabled: false,
      groupPolicy: 'disabled',
      dmPolicy: 'disabled',
      defaultRequireMention: true,
      defaultReplyStyle: 'thread',
    },
    msteams: {
      enabled: false,
      groupPolicy: 'disabled',
      dmPolicy: 'disabled',
      defaultRequireMention: true,
      defaultReplyStyle: 'thread',
    },
    channels: [],
    ...overrides,
  };
}

function makeConfigJob(
  overrides: Partial<AdminSchedulerJob> = {},
): AdminSchedulerJob {
  return {
    id: 'release-notes',
    source: 'config',
    name: 'Release Notes',
    description: 'Draft release notes once.',
    agentId: 'main',
    boardStatus: 'backlog',
    maxRetries: null,
    enabled: true,
    schedule: {
      kind: 'cron',
      at: null,
      everyMs: null,
      expr: '0 * * * *',
      tz: 'Europe/Berlin',
    },
    action: {
      kind: 'agent_turn',
      message: 'Draft release notes.',
    },
    delivery: {
      kind: 'channel',
      channel: 'tui',
      to: 'tui',
      webhookUrl: '',
    },
    lastRun: null,
    lastStatus: null,
    nextRunAt: '2026-04-07T20:00:00.000Z',
    disabled: false,
    consecutiveErrors: 0,
    createdAt: null,
    sessionId: null,
    channelId: null,
    taskId: null,
    ...overrides,
  };
}

function renderSchedulerPage(): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <SchedulerPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('SchedulerPage', () => {
  beforeEach(() => {
    fetchChannelsMock.mockReset();
    fetchConfigMock.mockReset();
    fetchSchedulerMock.mockReset();
    saveSchedulerJobMock.mockReset();
    deleteSchedulerJobMock.mockReset();
    setSchedulerJobPausedMock.mockReset();
    useAuthMock.mockReset();
    fetchConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config: makeConfig(),
    });
    fetchChannelsMock.mockResolvedValue(makeChannelsResponse());
    useAuthMock.mockReturnValue({
      token: 'test-token',
      gatewayStatus: makeStatus(),
    });
    window.history.replaceState({}, '', '/admin/scheduler');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('loads the selected job from the jobId query parameter', async () => {
    fetchSchedulerMock.mockResolvedValue({
      jobs: [makeConfigJob()],
    });
    window.history.replaceState({}, '', '/admin/scheduler?jobId=release-notes');

    renderSchedulerPage();

    await waitFor(() => {
      expect((screen.getByLabelText('ID') as HTMLInputElement).value).toBe(
        'release-notes',
      );
    });
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe(
      'Release Notes',
    );
    expect(
      (screen.getByLabelText('Message') as HTMLTextAreaElement).value,
    ).toBe('Draft release notes.');
  });

  it('normalizes datetime-local input before saving at schedules', async () => {
    fetchSchedulerMock.mockResolvedValue({
      jobs: [makeConfigJob()],
    });
    saveSchedulerJobMock.mockImplementation(
      () => new Promise<AdminSchedulerResponse>(() => {}),
    );
    window.history.replaceState({}, '', '/admin/scheduler?jobId=release-notes');

    renderSchedulerPage();

    await waitFor(() => {
      expect((screen.getByLabelText('ID') as HTMLInputElement).value).toBe(
        'release-notes',
      );
    });

    fireEvent.change(screen.getByLabelText('Schedule'), {
      target: { value: 'at' },
    });
    fireEvent.change(screen.getByLabelText('Run at'), {
      target: { value: '2026-04-07T22:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save job' }));

    await waitFor(() => {
      expect(saveSchedulerJobMock).toHaveBeenCalledTimes(1);
    });

    expect(saveSchedulerJobMock).toHaveBeenCalledWith(
      'test-token',
      expect.objectContaining({
        id: 'release-notes',
        schedule: expect.objectContaining({
          kind: 'at',
          at: normalizeSchedulerAtInput('2026-04-07T22:00'),
        }),
      }),
    );
  });

  it('saves one-shot jobs with the configured retry count', async () => {
    fetchSchedulerMock.mockResolvedValue({
      jobs: [makeConfigJob()],
    });
    saveSchedulerJobMock.mockImplementation(
      () => new Promise<AdminSchedulerResponse>(() => {}),
    );
    window.history.replaceState({}, '', '/admin/scheduler?jobId=release-notes');

    renderSchedulerPage();

    await waitFor(() => {
      expect((screen.getByLabelText('ID') as HTMLInputElement).value).toBe(
        'release-notes',
      );
    });

    fireEvent.change(screen.getByLabelText('Schedule'), {
      target: { value: 'one_shot' },
    });
    expect(screen.queryByLabelText('Timezone')).toBeNull();
    fireEvent.change(screen.getByLabelText('Retries after failure'), {
      target: { value: '5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save job' }));

    await waitFor(() => {
      expect(saveSchedulerJobMock).toHaveBeenCalledTimes(1);
    });

    expect(saveSchedulerJobMock).toHaveBeenCalledWith(
      'test-token',
      expect.objectContaining({
        id: 'release-notes',
        boardStatus: 'backlog',
        maxRetries: 5,
        schedule: expect.objectContaining({
          kind: 'one_shot',
          at: null,
          tz: '',
        }),
      }),
    );
  });

  it('rejects one-shot retry counts above the backend limit', async () => {
    fetchSchedulerMock.mockResolvedValue({
      jobs: [makeConfigJob()],
    });
    window.history.replaceState({}, '', '/admin/scheduler?jobId=release-notes');

    renderSchedulerPage();

    await waitFor(() => {
      expect((screen.getByLabelText('ID') as HTMLInputElement).value).toBe(
        'release-notes',
      );
    });

    fireEvent.change(screen.getByLabelText('Schedule'), {
      target: { value: 'one_shot' },
    });
    fireEvent.change(screen.getByLabelText('Retries after failure'), {
      target: { value: '101' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save job' }));

    await waitFor(() => {
      expect(saveSchedulerJobMock).not.toHaveBeenCalled();
      expect(
        screen.getByText('Pick a valid retry count from 0 to 100.'),
      ).toBeTruthy();
    });
  });

  it('shows a dropdown with enabled channel types', async () => {
    fetchSchedulerMock.mockResolvedValue({
      jobs: [makeConfigJob()],
    });
    fetchConfigMock.mockResolvedValue({
      path: '/tmp/config.json',
      config: makeConfig({
        slack: {
          ...makeConfig().slack,
          enabled: true,
        },
        telegram: {
          ...makeConfig().telegram,
          enabled: true,
          dmPolicy: 'open',
        },
      }),
    });
    useAuthMock.mockReturnValue({
      token: 'test-token',
      gatewayStatus: makeStatus({
        slack: {
          botTokenConfigured: true,
          botTokenSource: 'runtime-secrets',
          appTokenConfigured: true,
          appTokenSource: 'runtime-secrets',
        },
      }),
    });
    window.history.replaceState({}, '', '/admin/scheduler?jobId=release-notes');

    renderSchedulerPage();

    await waitFor(() => {
      expect((screen.getByLabelText('ID') as HTMLInputElement).value).toBe(
        'release-notes',
      );
    });

    const options = Array.from(
      (screen.getByLabelText('Channel type') as HTMLSelectElement).options,
    ).map((option) => option.text);
    expect(options).toContain('Local TUI');
    expect(options).toContain('Discord');
    expect(options).toContain('Slack');
    expect(options).not.toContain('Telegram');
  });

  it('uses the implicit tui target without showing a channel id field', async () => {
    fetchSchedulerMock.mockResolvedValue({
      jobs: [makeConfigJob()],
    });
    saveSchedulerJobMock.mockImplementation(
      () => new Promise<AdminSchedulerResponse>(() => {}),
    );
    window.history.replaceState({}, '', '/admin/scheduler?jobId=release-notes');

    renderSchedulerPage();

    await waitFor(() => {
      expect((screen.getByLabelText('ID') as HTMLInputElement).value).toBe(
        'release-notes',
      );
    });

    expect(screen.queryByLabelText('Channel ID')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save job' }));

    await waitFor(() => {
      expect(saveSchedulerJobMock).toHaveBeenCalledTimes(1);
    });

    expect(saveSchedulerJobMock).toHaveBeenCalledWith(
      'test-token',
      expect.objectContaining({
        delivery: expect.objectContaining({
          kind: 'channel',
          channel: 'tui',
          to: 'tui',
        }),
      }),
    );
  });

  it('shows a channel selector when discord has multiple configured targets', async () => {
    fetchSchedulerMock.mockResolvedValue({
      jobs: [makeConfigJob()],
    });
    fetchChannelsMock.mockResolvedValue(
      makeChannelsResponse({
        channels: [
          {
            id: 'discord:guild-a:111111111111111111',
            transport: 'discord',
            guildId: 'guild-a',
            channelId: '111111111111111111',
            defaultMode: 'mention',
            config: {
              mode: 'mention',
            },
          },
          {
            id: 'discord:guild-b:222222222222222222',
            transport: 'discord',
            guildId: 'guild-b',
            channelId: '222222222222222222',
            defaultMode: 'mention',
            config: {
              mode: 'mention',
            },
          },
        ],
      }),
    );
    window.history.replaceState({}, '', '/admin/scheduler?jobId=release-notes');

    renderSchedulerPage();

    await waitFor(() => {
      expect((screen.getByLabelText('ID') as HTMLInputElement).value).toBe(
        'release-notes',
      );
    });

    fireEvent.change(screen.getByLabelText('Channel type'), {
      target: { value: 'discord' },
    });

    await waitFor(() => {
      expect(screen.getByLabelText('Channel')).toBeTruthy();
    });
    expect(screen.queryByLabelText('Channel ID')).toBeNull();
  });
});
