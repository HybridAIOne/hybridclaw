import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdminEmailDeleteResponse,
  AdminEmailFolderResponse,
  AdminEmailMailboxResponse,
  AdminEmailMessageResponse,
} from '../api/types';
import { EmailPage } from './email';

const fetchAdminEmailMailboxMock =
  vi.fn<() => Promise<AdminEmailMailboxResponse>>();
const fetchAdminEmailFolderMock =
  vi.fn<
    (
      token: string,
      params: { folder: string; limit?: number; offset?: number },
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
const useAppShellConfigMock = vi.fn();

vi.mock('../api/client', () => ({
  fetchAdminEmailMailbox: () => fetchAdminEmailMailboxMock(),
  fetchAdminEmailFolder: (
    token: string,
    params: { folder: string; limit?: number; offset?: number },
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

vi.mock('../components/app-shell', () => ({
  useAppShellConfig: () => useAppShellConfigMock(),
}));

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

function renderEmailPage(options?: {
  configReady?: boolean;
  emailEnabled?: boolean;
}): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  useAppShellConfigMock.mockReturnValue({
    configReady: options?.configReady ?? true,
    emailEnabled: options?.emailEnabled ?? true,
  });

  render(
    <QueryClientProvider client={queryClient}>
      <EmailPage />
    </QueryClientProvider>,
  );
}

describe('EmailPage', () => {
  beforeEach(() => {
    fetchAdminEmailMailboxMock.mockReset();
    fetchAdminEmailFolderMock.mockReset();
    fetchAdminEmailMessageMock.mockReset();
    deleteAdminEmailMessageMock.mockReset();
    useAuthMock.mockReset();
    useAppShellConfigMock.mockReset();
    useAuthMock.mockReturnValue({ token: 'test-token' });
  });

  it('shows the list first, opens a selected message, and deletes from list or detail view', async () => {
    fetchAdminEmailMailboxMock.mockResolvedValue(makeMailboxResponse());
    const deletedMessageKeys = new Set<string>();
    fetchAdminEmailFolderMock.mockImplementation(
      async (_token, params): Promise<AdminEmailFolderResponse> =>
        params.folder === 'VIP'
          ? {
              folder: 'VIP',
              offset: params.offset || 0,
              limit: params.limit || 40,
              previousOffset: null,
              nextOffset: null,
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
              offset: params.offset || 0,
              limit: params.limit || 40,
              previousOffset: null,
              nextOffset: null,
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

    expect(
      await screen.findByRole('button', { name: /inbox/i }),
    ).not.toBeNull();
    expect(await screen.findByText('Quarterly plan')).not.toBeNull();
    expect(
      await screen.findByText(
        'Please review the updated budget before tomorrow morning and confirm th…',
      ),
    ).not.toBeNull();
    expect(fetchAdminEmailFolderMock).toHaveBeenCalledWith('test-token', {
      folder: 'INBOX',
      limit: 40,
      offset: 0,
    });
    expect(fetchAdminEmailMessageMock).not.toHaveBeenCalled();

    const quarterlyPlanButton = screen
      .getByText('Quarterly plan')
      .closest('button');
    expect(quarterlyPlanButton).not.toBeNull();
    if (!quarterlyPlanButton) {
      throw new Error('Quarterly plan button not found');
    }
    fireEvent.click(quarterlyPlanButton);

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
    expect(
      await screen.findByRole('button', { name: /back to message list/i }),
    ).not.toBeNull();
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

    const boardUpdateButton = screen
      .getByText('Board update')
      .closest('button');
    expect(boardUpdateButton).not.toBeNull();
    if (!boardUpdateButton) {
      throw new Error('Board update button not found');
    }
    fireEvent.click(boardUpdateButton);

    expect(
      await screen.findByRole('heading', { name: 'Board update' }),
    ).not.toBeNull();
    expect(
      await screen.findByText('Circling back on the board pack.'),
    ).not.toBeNull();
    expect(screen.getByRole('button', { name: /delete/i })).not.toBeNull();

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

  it('pages through mailbox messages with previous and next controls', async () => {
    fetchAdminEmailMailboxMock.mockResolvedValue(makeMailboxResponse());
    fetchAdminEmailFolderMock.mockImplementation(
      async (_token, params): Promise<AdminEmailFolderResponse> => {
        const offset = params.offset || 0;
        if (offset >= 40) {
          return {
            folder: 'INBOX',
            offset,
            limit: params.limit || 40,
            previousOffset: 0,
            nextOffset: null,
            messages: [
              {
                folder: 'INBOX',
                uid: 12,
                messageId: '<msg-12@example.com>',
                subject: 'Older note',
                fromAddress: 'ops@example.com',
                fromName: 'Ops',
                preview: 'This is an older message on the second page.',
                receivedAt: '2026-04-08T09:00:00.000Z',
                seen: true,
                flagged: false,
                answered: false,
                hasAttachments: false,
              },
            ],
          };
        }

        return {
          folder: 'INBOX',
          offset,
          limit: params.limit || 40,
          previousOffset: null,
          nextOffset: 40,
          messages: [
            {
              folder: 'INBOX',
              uid: 44,
              messageId: '<msg-44@example.com>',
              subject: 'Quarterly plan',
              fromAddress: 'finance@example.com',
              fromName: 'Finance Ops',
              preview: 'Newest page one message.',
              receivedAt: '2026-04-09T09:00:00.000Z',
              seen: false,
              flagged: false,
              answered: true,
              hasAttachments: false,
            },
          ],
        };
      },
    );

    renderEmailPage();

    expect(await screen.findByText('Quarterly plan')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Previous' })).toHaveProperty(
      'disabled',
      true,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByText('Older note')).not.toBeNull();
    expect(fetchAdminEmailFolderMock).toHaveBeenCalledWith('test-token', {
      folder: 'INBOX',
      limit: 40,
      offset: 40,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));

    expect(await screen.findByText('Quarterly plan')).not.toBeNull();
  });

  it('shows setup guidance when email is disabled', async () => {
    renderEmailPage({ emailEnabled: false });

    expect(
      await screen.findByText(
        'Enable the email channel to surface a mailbox view here.',
      ),
    ).not.toBeNull();
    expect(
      screen.getByRole('link', { name: /open channel settings/i }),
    ).not.toBeNull();
    expect(fetchAdminEmailMailboxMock).not.toHaveBeenCalled();
  });

  it('shows setup guidance when the mailbox endpoint reports email disabled', async () => {
    fetchAdminEmailMailboxMock.mockResolvedValue({
      ...makeMailboxResponse(),
      enabled: false,
      folders: [],
      defaultFolder: null,
    });

    renderEmailPage();

    expect(
      await screen.findByText(
        'Enable the email channel to surface a mailbox view here.',
      ),
    ).not.toBeNull();
    expect(fetchAdminEmailMailboxMock).toHaveBeenCalledTimes(1);
    expect(fetchAdminEmailFolderMock).not.toHaveBeenCalled();
  });
});
