import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdminConfigResponse,
  AdminEmailDeleteResponse,
  AdminEmailFolderResponse,
  AdminEmailMailboxResponse,
  AdminEmailMessageResponse,
} from '../api/types';
import { EmailPage } from './email';

const fetchConfigMock = vi.fn<() => Promise<AdminConfigResponse>>();
const fetchAdminEmailMailboxMock =
  vi.fn<() => Promise<AdminEmailMailboxResponse>>();
const fetchAdminEmailFolderMock =
  vi.fn<
    (
      token: string,
      params: { folder: string; limit?: number },
    ) => Promise<AdminEmailFolderResponse>
  >();
const fetchAdminEmailMessageMock =
  vi.fn<
    (
      token: string,
      params: { folder: string; uid: number },
    ) => Promise<AdminEmailMessageResponse>
  >();
const deleteAdminEmailMessageMock =
  vi.fn<
    (
      token: string,
      params: { folder: string; uid: number },
    ) => Promise<AdminEmailDeleteResponse>
  >();
const useAuthMock = vi.fn();

vi.mock('../api/client', () => ({
  fetchConfig: () => fetchConfigMock(),
  fetchAdminEmailMailbox: () => fetchAdminEmailMailboxMock(),
  fetchAdminEmailFolder: (
    token: string,
    params: { folder: string; limit?: number },
  ) => fetchAdminEmailFolderMock(token, params),
  fetchAdminEmailMessage: (
    token: string,
    params: { folder: string; uid: number },
  ) => fetchAdminEmailMessageMock(token, params),
  deleteAdminEmailMessage: (
    token: string,
    params: { folder: string; uid: number },
  ) => deleteAdminEmailMessageMock(token, params),
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
    defaultFolder: 'INBOX',
    folders: [
      {
        path: 'INBOX',
        name: 'Inbox',
        specialUse: '\\Inbox',
        total: 12,
        unseen: 2,
      },
      {
        path: 'VIP',
        name: 'VIP',
        specialUse: null,
        total: 3,
        unseen: 1,
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
    fetchAdminEmailFolderMock.mockReset();
    fetchAdminEmailMessageMock.mockReset();
    deleteAdminEmailMessageMock.mockReset();
    useAuthMock.mockReset();
    useAuthMock.mockReturnValue({ token: 'test-token' });
  });

  it('shows the list first, opens a selected message, and deletes from list or detail view', async () => {
    fetchConfigMock.mockResolvedValue(makeConfigResponse(true));
    fetchAdminEmailMailboxMock.mockResolvedValue(makeMailboxResponse());
    const deletedMessageKeys = new Set<string>();
    fetchAdminEmailFolderMock.mockImplementation(
      async (_token, params): Promise<AdminEmailFolderResponse> =>
        params.folder === 'VIP'
          ? {
              folder: 'VIP',
              messages: deletedMessageKeys.has('VIP:90')
                ? []
                : [
                    {
                      folder: 'VIP',
                      uid: 90,
                      messageId: '<msg-90@example.com>',
                      subject: 'Board update',
                      fromAddress: 'founder@example.com',
                      fromName: 'Founder',
                      preview: 'Attached is the latest board update.',
                      receivedAt: '2026-04-10T09:00:00.000Z',
                      seen: false,
                      flagged: false,
                      answered: false,
                      hasAttachments: true,
                    },
                  ],
            }
          : {
              folder: 'INBOX',
              messages: deletedMessageKeys.has('INBOX:44')
                ? []
                : [
                    {
                      folder: 'INBOX',
                      uid: 44,
                      messageId: '<msg-44@example.com>',
                      subject: 'Quarterly plan',
                      fromAddress: 'finance@example.com',
                      fromName: 'Finance Ops',
                      preview:
                        'Please review the updated budget before tomorrow morning and confirm the final staffing numbers for each team.',
                      receivedAt: '2026-04-09T09:00:00.000Z',
                      seen: false,
                      flagged: false,
                      answered: true,
                      hasAttachments: false,
                    },
                  ],
            },
    );
    fetchAdminEmailMessageMock.mockImplementation(
      async (_token, params): Promise<AdminEmailMessageResponse> =>
        params.folder === 'VIP'
          ? {
              message: {
                folder: 'VIP',
                uid: 90,
                messageId: '<msg-90@example.com>',
                subject: 'Board update',
                fromAddress: 'founder@example.com',
                fromName: 'Founder',
                preview: 'Attached is the latest board update.',
                receivedAt: '2026-04-10T09:00:00.000Z',
                seen: false,
                flagged: false,
                answered: false,
                hasAttachments: true,
                to: [{ name: 'Agent', address: 'agent@example.com' }],
                cc: [],
                bcc: [],
                replyTo: [],
                text: 'Attached is the latest board update.',
                attachments: [
                  {
                    filename: 'board-update.pdf',
                    contentType: 'application/pdf',
                    size: 2048,
                  },
                ],
                metadata: null,
              },
              thread: [
                {
                  folder: 'VIP',
                  uid: 86,
                  messageId: '<msg-86@example.com>',
                  subject: 'Board update',
                  fromAddress: 'founder@example.com',
                  fromName: 'Founder',
                  preview: 'Circling back on the board pack.',
                  receivedAt: '2026-04-08T09:00:00.000Z',
                  seen: true,
                  flagged: false,
                  answered: false,
                  hasAttachments: false,
                  to: [{ name: 'Agent', address: 'agent@example.com' }],
                  cc: [],
                  bcc: [],
                  replyTo: [],
                  text: 'Circling back on the board pack.',
                  attachments: [],
                  metadata: null,
                },
                {
                  folder: 'VIP',
                  uid: 90,
                  messageId: '<msg-90@example.com>',
                  subject: 'Board update',
                  fromAddress: 'founder@example.com',
                  fromName: 'Founder',
                  preview: 'Attached is the latest board update.',
                  receivedAt: '2026-04-10T09:00:00.000Z',
                  seen: false,
                  flagged: false,
                  answered: false,
                  hasAttachments: true,
                  to: [{ name: 'Agent', address: 'agent@example.com' }],
                  cc: [],
                  bcc: [],
                  replyTo: [],
                  text: 'Attached is the latest board update.',
                  attachments: [
                    {
                      filename: 'board-update.pdf',
                      contentType: 'application/pdf',
                      size: 2048,
                    },
                  ],
                  metadata: {
                    agentId: 'main',
                    model: 'hybridai/gpt-5',
                    provider: 'hybridai',
                    totalTokens: 1234,
                    tokenSource: 'api',
                  },
                },
              ],
            }
          : {
              message: {
                folder: 'INBOX',
                uid: 44,
                messageId: '<msg-44@example.com>',
                subject: 'Quarterly plan',
                fromAddress: 'finance@example.com',
                fromName: 'Finance Ops',
                preview:
                  'Please review the updated budget before tomorrow morning and confirm the final staffing numbers for each team.',
                receivedAt: '2026-04-09T09:00:00.000Z',
                seen: false,
                flagged: false,
                answered: true,
                hasAttachments: false,
                to: [{ name: 'Agent', address: 'agent@example.com' }],
                cc: [],
                bcc: [],
                replyTo: [],
                text: 'Please review the updated budget.',
                attachments: [],
                metadata: {
                  agentId: 'main',
                  model: 'hybridai/gpt-5',
                  provider: 'hybridai',
                  totalTokens: 1234,
                  tokenSource: 'api',
                },
              },
              thread: [
                {
                  folder: 'INBOX',
                  uid: 40,
                  messageId: '<msg-40@example.com>',
                  subject: 'Quarterly plan',
                  fromAddress: 'finance@example.com',
                  fromName: 'Finance Ops',
                  preview: 'Initial budget draft shared yesterday.',
                  receivedAt: '2026-04-08T09:00:00.000Z',
                  seen: true,
                  flagged: false,
                  answered: false,
                  hasAttachments: false,
                  to: [{ name: 'Agent', address: 'agent@example.com' }],
                  cc: [],
                  bcc: [],
                  replyTo: [],
                  text: 'Initial budget draft shared yesterday.',
                  attachments: [],
                  metadata: null,
                },
                {
                  folder: 'INBOX',
                  uid: 44,
                  messageId: '<msg-44@example.com>',
                  subject: 'Quarterly plan',
                  fromAddress: 'finance@example.com',
                  fromName: 'Finance Ops',
                  preview:
                    'Please review the updated budget before tomorrow morning and confirm the final staffing numbers for each team.',
                  receivedAt: '2026-04-09T09:00:00.000Z',
                  seen: false,
                  flagged: false,
                  answered: true,
                  hasAttachments: false,
                  to: [{ name: 'Agent', address: 'agent@example.com' }],
                  cc: [],
                  bcc: [],
                  replyTo: [],
                  text: 'Please review the updated budget.',
                  attachments: [],
                  metadata: {
                    agentId: 'main',
                    model: 'hybridai/gpt-5',
                    provider: 'hybridai',
                    totalTokens: 1234,
                    tokenSource: 'api',
                  },
                },
              ],
            },
    );
    deleteAdminEmailMessageMock.mockImplementation(
      async (_token, params): Promise<AdminEmailDeleteResponse> => {
        deletedMessageKeys.add(`${params.folder}:${params.uid}`);
        return {
          deleted: true,
          targetFolder: 'Trash',
          permanent: false,
        };
      },
    );

    renderEmailPage();

    expect(await screen.findByRole('button', { name: /inbox/i })).not.toBeNull();
    expect(await screen.findByText('Quarterly plan')).not.toBeNull();
    expect(
      await screen.findByText(
        'Please review the updated budget before tomorrow morning and confirm th…',
      ),
    ).not.toBeNull();
    expect(fetchAdminEmailFolderMock).toHaveBeenCalledWith('test-token', {
      folder: 'INBOX',
      limit: 40,
    });
    expect(fetchAdminEmailMessageMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Quarterly plan').closest('button')!);

    expect(
      await screen.findByRole('heading', { name: 'Quarterly plan' }),
    ).not.toBeNull();
    expect(
      await screen.findByText('Initial budget draft shared yesterday.'),
    ).not.toBeNull();
    expect(await screen.findByText('Agent: main')).not.toBeNull();
    expect(await screen.findByText('Model: hybridai/gpt-5')).not.toBeNull();
    expect(await screen.findByText('Provider: hybridai')).not.toBeNull();
    expect(await screen.findByText('Tokens: 1,234')).not.toBeNull();
    expect(await screen.findByRole('button', { name: /back to message list/i })).not.toBeNull();
    expect(fetchAdminEmailMessageMock).toHaveBeenCalledWith('test-token', {
      folder: 'INBOX',
      uid: 44,
    });

    fireEvent.click(
      screen.getByRole('button', { name: /back to message list/i }),
    );

    expect(await screen.findByText('Quarterly plan')).not.toBeNull();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Delete Quarterly plan' }),
    );

    await waitFor(() =>
      expect(deleteAdminEmailMessageMock).toHaveBeenCalledWith('test-token', {
        folder: 'INBOX',
        uid: 44,
      }),
    );
    expect(
      await screen.findByText('No IMAP messages match this folder and search.'),
    ).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /vip/i }));
    expect(await screen.findByText('Board update')).not.toBeNull();

    fireEvent.click(screen.getByText('Board update').closest('button')!);

    expect(
      await screen.findByRole('heading', { name: 'Board update' }),
    ).not.toBeNull();
    expect(
      await screen.findByText('Circling back on the board pack.'),
    ).not.toBeNull();
    expect(
      screen.getByRole('button', { name: /delete/i }),
    ).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    await waitFor(() =>
      expect(deleteAdminEmailMessageMock).toHaveBeenCalledWith('test-token', {
        folder: 'VIP',
        uid: 90,
      }),
    );
    expect(
      await screen.findByText('No IMAP messages match this folder and search.'),
    ).not.toBeNull();

    expect(fetchAdminEmailMessageMock).toHaveBeenCalledWith('test-token', {
      folder: 'VIP',
      uid: 90,
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
