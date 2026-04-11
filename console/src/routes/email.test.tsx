import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdminConfigResponse,
  AdminEmailMailboxResponse,
  GatewayHistoryResponse,
} from '../api/types';
import { EmailPage } from './email';

const fetchConfigMock = vi.fn<() => Promise<AdminConfigResponse>>();
const fetchAdminEmailMailboxMock =
  vi.fn<() => Promise<AdminEmailMailboxResponse>>();
const fetchHistoryMock =
  vi.fn<
    (
      token: string,
      params: { sessionId: string; limit?: number },
    ) => Promise<GatewayHistoryResponse>
  >();
const useAuthMock = vi.fn();

vi.mock('../api/client', () => ({
  fetchConfig: () => fetchConfigMock(),
  fetchAdminEmailMailbox: () => fetchAdminEmailMailboxMock(),
  fetchHistory: (
    token: string,
    params: { sessionId: string; limit?: number },
  ) => fetchHistoryMock(token, params),
}));

vi.mock('../auth', () => ({
  useAuth: () => useAuthMock(),
}));

function makeConfigResponse(enabled: boolean): AdminConfigResponse {
  return {
    path: '/tmp/config.json',
    config: {
      version: 1,
      hybridai: {
        baseUrl: '',
        defaultModel: 'gpt-5',
        defaultChatbotId: '',
        maxTokens: 0,
        enableRag: false,
        models: [],
      },
      discord: {
        prefix: '!',
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
        maxLinesPerMessage: 10,
        humanDelay: { mode: 'off', minMs: 0, maxMs: 0 },
        typingMode: 'instant',
        presence: {
          enabled: false,
          intervalMs: 0,
          healthyText: '',
          degradedText: '',
          exhaustedText: '',
          activityType: 'playing',
        },
        lifecycleReactions: {
          enabled: false,
          removeOnComplete: false,
          phases: {
            queued: '',
            thinking: '',
            toolUse: '',
            streaming: '',
            done: '',
            error: '',
          },
        },
        debounceMs: 0,
        ackReaction: '',
        ackReactionScope: 'off',
        removeAckAfterReply: false,
        rateLimitPerUser: 0,
        rateLimitExemptRoles: [],
        suppressPatterns: [],
        maxConcurrentPerChannel: 0,
        guilds: {},
      },
      msteams: {
        enabled: false,
        appId: '',
        tenantId: '',
        webhook: { port: 0, path: '' },
        groupPolicy: 'disabled',
        dmPolicy: 'disabled',
        allowFrom: [],
        teams: {},
        requireMention: false,
        textChunkLimit: 0,
        replyStyle: 'thread',
        mediaMaxMb: 5,
        dangerouslyAllowNameMatching: false,
        mediaAllowHosts: [],
        mediaAuthAllowHosts: [],
      },
      telegram: {
        enabled: false,
        botToken: '',
        pollIntervalMs: 0,
        dmPolicy: 'disabled',
        groupPolicy: 'disabled',
        allowFrom: [],
        groupAllowFrom: [],
        requireMention: false,
        textChunkLimit: 0,
        mediaMaxMb: 5,
      },
      whatsapp: {
        dmPolicy: 'disabled',
        groupPolicy: 'disabled',
        allowFrom: [],
        groupAllowFrom: [],
        textChunkLimit: 0,
        debounceMs: 0,
        sendReadReceipts: false,
        ackReaction: '',
        mediaMaxMb: 5,
      },
      imessage: {
        enabled: false,
        backend: 'local',
        cliPath: '',
        dbPath: '',
        pollIntervalMs: 0,
        serverUrl: '',
        password: '',
        webhookPath: '',
        allowPrivateNetwork: false,
        dmPolicy: 'disabled',
        groupPolicy: 'disabled',
        allowFrom: [],
        groupAllowFrom: [],
        textChunkLimit: 0,
        debounceMs: 0,
        mediaMaxMb: 5,
      },
      email: {
        enabled,
        imapHost: 'imap.example.com',
        imapPort: 993,
        imapSecure: true,
        smtpHost: 'smtp.example.com',
        smtpPort: 465,
        smtpSecure: true,
        address: 'agent@example.com',
        password: '',
        pollIntervalMs: 60_000,
        folders: ['INBOX', 'VIP'],
        allowFrom: [],
        textChunkLimit: 50_000,
        mediaMaxMb: 10,
      },
      container: {
        sandboxMode: 'container',
        image: '',
        memory: '',
        memorySwap: '',
        cpus: '',
        network: '',
        timeoutMs: 0,
        binds: [],
        additionalMounts: '',
        maxOutputBytes: 0,
        maxConcurrent: 0,
      },
      ops: {
        healthHost: '',
        healthPort: 0,
        webApiToken: '',
        gatewayBaseUrl: '',
        gatewayApiToken: '',
        dbPath: '',
        logLevel: 'info',
      },
    },
  };
}

function makeMailboxResponse(): AdminEmailMailboxResponse {
  return {
    enabled: true,
    address: 'agent@example.com',
    folders: ['INBOX', 'VIP'],
    threads: [
      {
        sessionId: 'email-session-2',
        channelId: 'founder@example.com',
        senderName: 'Founder',
        subject: 'Launch checklist',
        preview: 'Can you confirm the status on the rollout?',
        summary: null,
        messageCount: 1,
        userMessageCount: 1,
        lastMessageRole: 'user',
        createdAt: '2026-04-10T08:00:00.000Z',
        lastActive: '2026-04-10T09:00:00.000Z',
      },
      {
        sessionId: 'email-session-1',
        channelId: 'finance@example.com',
        senderName: 'Finance Ops',
        subject: 'Quarterly plan',
        preview: 'Budget reviewed. I sent the highlights back already.',
        summary: null,
        messageCount: 2,
        userMessageCount: 1,
        lastMessageRole: 'assistant',
        createdAt: '2026-04-09T08:00:00.000Z',
        lastActive: '2026-04-09T09:00:00.000Z',
      },
    ],
  };
}

function renderEmailPage(): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <EmailPage />
    </QueryClientProvider>,
  );
}

describe('EmailPage', () => {
  beforeEach(() => {
    fetchConfigMock.mockReset();
    fetchAdminEmailMailboxMock.mockReset();
    fetchHistoryMock.mockReset();
    useAuthMock.mockReset();
    useAuthMock.mockReturnValue({ token: 'test-token' });
  });

  it('shows mailbox threads and opens the selected conversation', async () => {
    fetchConfigMock.mockResolvedValue(makeConfigResponse(true));
    fetchAdminEmailMailboxMock.mockResolvedValue(makeMailboxResponse());
    fetchHistoryMock.mockImplementation(
      async (_token, params): Promise<GatewayHistoryResponse> => ({
        sessionId: params.sessionId,
        history:
          params.sessionId === 'email-session-2'
            ? [
                {
                  id: 2,
                  session_id: 'email-session-2',
                  user_id: 'founder@example.com',
                  username: 'Founder',
                  role: 'user',
                  content:
                    '[Subject: Launch checklist]\n\nCan you confirm the status on the rollout?',
                  created_at: '2026-04-10T09:00:00.000Z',
                },
              ]
            : [
                {
                  id: 1,
                  session_id: 'email-session-1',
                  user_id: 'finance@example.com',
                  username: 'Finance Ops',
                  role: 'user',
                  content:
                    '[Subject: Quarterly plan]\n\nPlease review the updated budget.',
                  created_at: '2026-04-09T08:00:00.000Z',
                },
                {
                  id: 3,
                  session_id: 'email-session-1',
                  user_id: 'assistant',
                  username: 'HybridClaw',
                  role: 'assistant',
                  content:
                    'Budget reviewed. I sent the highlights back already.',
                  created_at: '2026-04-09T09:00:00.000Z',
                },
              ],
      }),
    );

    renderEmailPage();

    expect(
      await screen.findByRole('heading', { name: 'Launch checklist' }),
    ).not.toBeNull();
    expect(await screen.findByText('Waiting on HybridClaw')).not.toBeNull();
    expect(
      await screen.findByRole('button', { name: /finance ops/i }),
    ).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /finance ops/i }));

    expect(
      await screen.findByText(
        'Budget reviewed. I sent the highlights back already.',
      ),
    ).not.toBeNull();
    expect(fetchHistoryMock).toHaveBeenCalledWith('test-token', {
      sessionId: 'email-session-1',
      limit: 200,
    });
  });

  it('shows setup guidance when email is disabled', async () => {
    fetchConfigMock.mockResolvedValue(makeConfigResponse(false));
    fetchAdminEmailMailboxMock.mockResolvedValue(makeMailboxResponse());

    renderEmailPage();

    expect(
      await screen.findByText(
        'Enable the email channel to surface a mailbox view here.',
      ),
    ).not.toBeNull();
    expect(
      screen.getByRole('link', { name: /open channel settings/i }),
    ).not.toBeNull();
  });
});
