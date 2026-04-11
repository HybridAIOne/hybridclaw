import { Readable } from 'node:stream';
import { afterEach, expect, test, vi } from 'vitest';

const BASE_EMAIL_CONFIG = {
  enabled: true,
  imapHost: 'imap.example.com',
  imapPort: 993,
  imapSecure: true,
  smtpHost: 'smtp.example.com',
  smtpPort: 587,
  smtpSecure: false,
  address: 'agent@example.com',
  password: '',
  pollIntervalMs: 30_000,
  folders: ['INBOX', 'VIP'],
  allowFrom: ['*'],
  textChunkLimit: 50_000,
  mediaMaxMb: 20,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('imapflow');
  vi.doUnmock('mailparser');
  vi.doUnmock('../src/memory/db.js');
});

function mockAdminMailboxDb(options?: {
  sessions?: Array<Record<string, unknown>>;
  messages?: Array<Record<string, unknown>>;
  usageEvents?: Array<Record<string, unknown>>;
  structuredAudit?: Array<Record<string, unknown>>;
}) {
  const getSessionById = vi.fn((sessionId: string) =>
    (options?.sessions || []).find(
      (entry) => String(entry.id || '') === sessionId,
    ),
  );
  const getSessionsByChannelId = vi.fn((channelId: string) =>
    (options?.sessions || []).filter(
      (entry) => String(entry.channel_id || '') === channelId,
    ),
  );
  const getRecentMessages = vi.fn((sessionId: string) =>
    (options?.messages || []).filter(
      (entry) => String(entry.session_id || '') === sessionId,
    ),
  );
  const getRecentSessionUsageEvents = vi.fn((sessionId: string) =>
    (options?.usageEvents || []).filter(
      (entry) => String(entry.sessionId || '') === sessionId,
    ),
  );
  const getRecentStructuredAuditForSession = vi.fn((sessionId: string) =>
    (options?.structuredAudit || []).filter(
      (entry) => String(entry.session_id || '') === sessionId,
    ),
  );
  const getRecentStructuredAudit = vi.fn(() => options?.structuredAudit || []);
  const searchStructuredAudit = vi.fn(() => options?.structuredAudit || []);

  vi.doMock('../src/memory/db.js', () => ({
    getSessionById,
    getSessionsByChannelId,
    getRecentMessages,
    getRecentSessionUsageEvents,
    getRecentStructuredAudit,
    getRecentStructuredAuditForSession,
    searchStructuredAudit,
  }));

  return {
    getSessionById,
    getSessionsByChannelId,
    getRecentMessages,
    getRecentSessionUsageEvents,
    getRecentStructuredAudit,
    getRecentStructuredAuditForSession,
    searchStructuredAudit,
  };
}

test('lists live IMAP folders and message previews for the selected folder', async () => {
  mockAdminMailboxDb();
  const release = vi.fn();
  const list = vi.fn(async () => [
    {
      path: 'INBOX',
      name: 'Inbox',
      flags: new Set<string>(),
      specialUse: '\\Inbox',
      status: {
        messages: 12,
        unseen: 3,
      },
    },
    {
      path: 'Hidden',
      name: 'Hidden',
      flags: new Set<string>(['\\Noselect']),
      status: {
        messages: 99,
        unseen: 99,
      },
    },
    {
      path: 'VIP',
      name: 'VIP',
      flags: new Set<string>(),
      status: {
        messages: 4,
        unseen: 1,
      },
    },
  ]);
  const getMailboxLock = vi.fn(async () => ({ path: 'INBOX', release }));
  const search = vi.fn(async () => [41, 44]);
  const fetchAll = vi.fn(async () => [
    {
      seq: 1,
      uid: 44,
      envelope: {
        messageId: '<msg-44@example.com>',
        subject: 'Quarterly plan',
        from: [{ name: 'Finance Ops', address: 'finance@example.com' }],
      },
      internalDate: new Date('2026-03-11T10:00:00.000Z'),
      flags: new Set<string>(['\\Answered']),
      bodyStructure: { part: '1', type: 'text/plain' },
    },
    {
      seq: 2,
      uid: 41,
      envelope: {
        messageId: '<msg-41@example.com>',
        subject: 'Town hall',
        from: [{ name: 'Founder', address: 'founder@example.com' }],
      },
      internalDate: new Date('2026-03-10T09:00:00.000Z'),
      flags: new Set<string>(['\\Seen']),
      bodyStructure: { part: '1', type: 'text/plain' },
    },
  ]);
  const download = vi.fn(async (uid: string) => ({
    meta: {},
    content: Readable.from([
      uid === '44'
        ? 'Please review the updated budget.'
        : 'Agenda attached for the town hall.',
    ]),
  }));
  const mockClient = {
    connect: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
    close: vi.fn(() => {}),
    list,
    getMailboxLock,
    search,
    fetchAll,
    download,
  };
  const MockImapFlow = vi.fn(function MockImapFlow() {
    return mockClient;
  });

  vi.doMock('imapflow', () => ({ ImapFlow: MockImapFlow }));

  const { fetchLiveAdminEmailFolder, fetchLiveAdminEmailMailbox } =
    await import('../src/channels/email/admin-mailbox.js');

  const mailbox = await fetchLiveAdminEmailMailbox(BASE_EMAIL_CONFIG, 'secret');
  const folder = await fetchLiveAdminEmailFolder(BASE_EMAIL_CONFIG, 'secret', {
    folder: 'INBOX',
    limit: 20,
  });

  expect(mailbox).toMatchObject({
    address: 'agent@example.com',
    defaultFolder: 'INBOX',
    folders: [
      {
        path: 'INBOX',
        unseen: 3,
      },
      {
        path: 'VIP',
        unseen: 1,
      },
    ],
  });
  expect(mailbox.folders).toHaveLength(2);
  expect(folder).toMatchObject({
    folder: 'INBOX',
    messages: [
      {
        uid: 44,
        subject: 'Quarterly plan',
        fromAddress: 'finance@example.com',
        preview: 'Please review the updated budget.',
        answered: true,
      },
      {
        uid: 41,
        subject: 'Town hall',
        fromAddress: 'founder@example.com',
        preview: 'Agenda attached for the town hall.',
        seen: true,
      },
    ],
  });
  expect(search).toHaveBeenCalledWith({ all: true }, { uid: true });
  expect(release).toHaveBeenCalledTimes(1);
});

test('parses a live IMAP message into message detail', async () => {
  mockAdminMailboxDb();
  const inboxRelease = vi.fn();
  const sentRelease = vi.fn();
  const list = vi.fn(async () => [
    {
      path: 'INBOX',
      name: 'Inbox',
      flags: new Set<string>(),
      specialUse: '\\Inbox',
    },
    {
      path: 'Sent',
      name: 'Sent',
      flags: new Set<string>(),
      specialUse: '\\Sent',
    },
  ]);
  const search = vi.fn(async (query: { threadId?: string }) => {
    if (query.threadId !== 'thread-1') return [];
    return mockClient.mailbox?.path === 'Sent' ? [51] : [40, 44];
  });
  const fetchAll = vi.fn(async (uids: number[]) =>
    uids.includes(51)
      ? [
          {
            seq: 3,
            uid: 51,
            source: Buffer.from('raw sent reply'),
            envelope: {
              messageId: '<msg-51@example.com>',
              subject: 'Quarterly plan',
              from: [{ name: 'Main Agent', address: 'agent@example.com' }],
              date: new Date('2026-03-11T10:05:00.000Z'),
            },
            internalDate: new Date('2026-03-11T10:05:00.000Z'),
            flags: new Set<string>(['\\Seen']),
            bodyStructure: { part: '1', type: 'text/plain' },
            threadId: 'thread-1',
          },
        ]
      : [
          {
            seq: 1,
            uid: 40,
            source: Buffer.from('raw earlier message'),
            envelope: {
              messageId: '<msg-40@example.com>',
              subject: 'Quarterly plan',
              from: [{ name: 'Finance Ops', address: 'finance@example.com' }],
              date: new Date('2026-03-10T10:00:00.000Z'),
            },
            internalDate: new Date('2026-03-10T10:00:00.000Z'),
            flags: new Set<string>(['\\Seen']),
            bodyStructure: { part: '1', type: 'text/plain' },
            threadId: 'thread-1',
          },
        ],
  );
  const fetchOne = vi.fn(async () => ({
    seq: 2,
    uid: 44,
    source: Buffer.from('raw message'),
    envelope: {
      messageId: '<msg-44@example.com>',
      subject: 'Quarterly plan',
      from: [{ name: 'Finance Ops', address: 'finance@example.com' }],
      date: new Date('2026-03-11T10:00:00.000Z'),
    },
    internalDate: new Date('2026-03-11T10:00:00.000Z'),
    flags: new Set<string>(['\\Seen', '\\Answered']),
    bodyStructure: { part: '1', type: 'text/plain' },
    threadId: 'thread-1',
  }));
  const parsedMailBySource = new Map<string, unknown>([
    [
      'raw message',
      {
        messageId: '<msg-44@example.com>',
        subject: 'Quarterly plan',
        date: new Date('2026-03-11T10:00:00.000Z'),
        from: {
          value: [{ name: 'Finance Ops', address: 'finance@example.com' }],
        },
        to: {
          value: [{ name: 'Agent', address: 'agent@example.com' }],
        },
        cc: {
          value: [{ name: 'COO', address: 'coo@example.com' }],
        },
        bcc: undefined,
        replyTo: {
          value: [{ name: 'Finance Ops', address: 'finance@example.com' }],
        },
        headers: new Map<string, string>([
          ['x-hybridclaw-agent-id', 'main'],
          ['x-hybridclaw-llm', 'hybridai/gpt-5'],
          ['x-hybridclaw-provider', 'hybridai'],
          ['x-hybridclaw-total-tokens', '1234'],
          ['x-hybridclaw-token-source', 'api'],
        ]),
        text: 'Please review the updated budget.',
        attachments: [
          {
            filename: 'budget.xlsx',
            contentType:
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            size: 2048,
          },
        ],
      },
    ],
    [
      'raw earlier message',
      {
        messageId: '<msg-40@example.com>',
        subject: 'Quarterly plan',
        date: new Date('2026-03-10T10:00:00.000Z'),
        from: {
          value: [{ name: 'Finance Ops', address: 'finance@example.com' }],
        },
        to: {
          value: [{ name: 'Agent', address: 'agent@example.com' }],
        },
        cc: undefined,
        bcc: undefined,
        replyTo: undefined,
        headers: new Map<string, string>(),
        text: 'Initial budget draft shared yesterday.',
        attachments: [],
      },
    ],
    [
      'raw sent reply',
      {
        messageId: '<msg-51@example.com>',
        subject: 'Quarterly plan',
        date: new Date('2026-03-11T10:05:00.000Z'),
        from: {
          value: [{ name: 'Main Agent', address: 'agent@example.com' }],
        },
        to: {
          value: [{ name: 'Finance Ops', address: 'finance@example.com' }],
        },
        cc: undefined,
        bcc: undefined,
        replyTo: undefined,
        headers: new Map<string, string>([
          ['x-hybridclaw-agent-id', 'main'],
          ['x-hybridclaw-llm', 'hybridai/gpt-5'],
          ['x-hybridclaw-provider', 'hybridai'],
          ['x-hybridclaw-total-tokens', '1234'],
          ['x-hybridclaw-token-source', 'api'],
        ]),
        text: 'Reply sent from the agent.',
        attachments: [],
      },
    ],
  ]);
  const mockClient = {
    mailbox: { path: 'INBOX' },
    connect: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
    close: vi.fn(() => {}),
    list,
    getMailboxLock: vi.fn(async (path: string) => {
      mockClient.mailbox = { path };
      return { path, release: path === 'Sent' ? sentRelease : inboxRelease };
    }),
    search,
    fetchAll,
    fetchOne,
  };
  const MockImapFlow = vi.fn(function MockImapFlow() {
    return mockClient;
  });
  const simpleParser = vi.fn(async (source: Buffer) =>
    parsedMailBySource.get(source.toString('utf8')),
  );

  vi.doMock('imapflow', () => ({ ImapFlow: MockImapFlow }));
  vi.doMock('mailparser', () => ({ simpleParser }));

  const { fetchLiveAdminEmailMessage } = await import(
    '../src/channels/email/admin-mailbox.js'
  );

  const message = await fetchLiveAdminEmailMessage(
    BASE_EMAIL_CONFIG,
    'secret',
    {
      folder: 'INBOX',
      uid: 44,
    },
  );

  expect(message).toMatchObject({
    message: {
      folder: 'INBOX',
      uid: 44,
      subject: 'Quarterly plan',
      fromAddress: 'finance@example.com',
      text: 'Please review the updated budget.',
      seen: true,
      answered: true,
      attachments: [
        {
          filename: 'budget.xlsx',
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
      to: [{ address: 'agent@example.com' }],
      cc: [{ address: 'coo@example.com' }],
    },
    thread: [
      {
        uid: 40,
        text: 'Initial budget draft shared yesterday.',
        metadata: null,
      },
      {
        uid: 44,
        text: 'Please review the updated budget.',
        metadata: {
          agentId: 'main',
          model: 'hybridai/gpt-5',
          provider: 'hybridai',
          totalTokens: 1234,
          tokenSource: 'api',
        },
      },
      {
        folder: 'Sent',
        uid: 51,
        fromAddress: 'agent@example.com',
        text: 'Reply sent from the agent.',
        metadata: {
          agentId: 'main',
          model: 'hybridai/gpt-5',
          provider: 'hybridai',
          totalTokens: 1234,
          tokenSource: 'api',
        },
      },
    ],
  });
  expect(search).toHaveBeenCalledWith({ threadId: 'thread-1' }, { uid: true });
  expect(fetchAll).toHaveBeenCalledTimes(2);
  expect(fetchOne).toHaveBeenCalledTimes(1);
  expect(inboxRelease).toHaveBeenCalledTimes(1);
  expect(sentRelease).toHaveBeenCalledTimes(1);
});

test('links sent replies via message headers when IMAP thread ids are unavailable', async () => {
  mockAdminMailboxDb({
    sessions: [
      {
        id: 'email:finance@example.com',
        session_key:
          'agent:main:channel:email:chat:dm:peer:finance%40example.com',
        main_session_key:
          'agent:main:channel:email:chat:dm:peer:finance%40example.com',
        is_current: 1,
        legacy_session_id: 'email:finance@example.com',
        guild_id: null,
        channel_id: 'finance@example.com',
        agent_id: 'main',
        chatbot_id: null,
        model: 'openai-codex/gpt-5.4',
        enable_rag: 0,
        message_count: 2,
        session_summary: null,
        summary_updated_at: null,
        compaction_count: 0,
        memory_flush_at: null,
        full_auto_enabled: 0,
        full_auto_prompt: null,
        full_auto_started_at: null,
        show_mode: 'all',
        created_at: '2026-03-11T09:00:00.000Z',
        last_active: '2026-03-11T10:05:00.000Z',
        reset_count: 0,
        reset_at: null,
      },
    ],
    messages: [
      {
        id: 1001,
        session_id: 'email:finance@example.com',
        user_id: 'assistant',
        username: null,
        role: 'assistant',
        content: '__MESSAGE_SEND_HANDLED__',
        created_at: '2026-03-11T10:05:10.000Z',
      },
    ],
    usageEvents: [
      {
        sessionId: 'email:finance@example.com',
        agentId: 'main',
        model: 'openai-codex/gpt-5.4',
        totalTokens: 1234,
        timestamp: '2026-03-11T10:05:11.000Z',
      },
    ],
  });
  const inboxRelease = vi.fn();
  const sentRelease = vi.fn();
  const list = vi.fn(async () => [
    {
      path: 'INBOX',
      name: 'Inbox',
      flags: new Set<string>(),
      specialUse: '\\Inbox',
    },
    {
      path: 'Sent',
      name: 'Sent',
      flags: new Set<string>(),
      specialUse: '\\Sent',
    },
  ]);
  const search = vi.fn(
    async (query: { threadId?: string; header?: Record<string, string> }) => {
      if (query.threadId) return [];
      const inReplyTo = query.header?.['in-reply-to'];
      const references = query.header?.references;
      if (
        (inReplyTo === '<msg-44@example.com>' ||
          references === '<msg-44@example.com>') &&
        mockClient.mailbox?.path === 'Sent'
      ) {
        return [51];
      }
      return [];
    },
  );
  const fetchAll = vi.fn(async (uids: number[]) =>
    uids.includes(51)
      ? [
          {
            seq: 3,
            uid: 51,
            source: Buffer.from('raw sent reply'),
            envelope: {
              messageId: '<msg-51@example.com>',
              subject: 'Hej, wie läufts?',
              from: [{ name: 'Main Agent', address: 'agent@example.com' }],
              date: new Date('2026-03-11T10:05:00.000Z'),
            },
            internalDate: new Date('2026-03-11T10:05:00.000Z'),
            flags: new Set<string>(['\\Seen']),
            bodyStructure: { part: '1', type: 'text/plain' },
          },
        ]
      : [],
  );
  const fetchOne = vi.fn(async () => ({
    seq: 2,
    uid: 44,
    source: Buffer.from('raw message'),
    envelope: {
      messageId: '<msg-44@example.com>',
      subject: 'Hej, wie läufts?',
      from: [{ name: 'Finance Ops', address: 'finance@example.com' }],
      date: new Date('2026-03-11T10:00:00.000Z'),
    },
    internalDate: new Date('2026-03-11T10:00:00.000Z'),
    flags: new Set<string>(['\\Seen', '\\Answered']),
    bodyStructure: { part: '1', type: 'text/plain' },
  }));
  const parsedMailBySource = new Map<string, unknown>([
    [
      'raw message',
      {
        messageId: '<msg-44@example.com>',
        subject: 'Hej, wie läufts?',
        date: new Date('2026-03-11T10:00:00.000Z'),
        from: {
          value: [{ name: 'Finance Ops', address: 'finance@example.com' }],
        },
        to: {
          value: [{ name: 'Agent', address: 'agent@example.com' }],
        },
        cc: undefined,
        bcc: undefined,
        replyTo: undefined,
        references: undefined,
        inReplyTo: undefined,
        headers: new Map<string, string>(),
        text: 'Inbound message.',
        attachments: [],
      },
    ],
    [
      'raw sent reply',
      {
        messageId: '<msg-51@example.com>',
        subject: 'Re: Hej, wie läufts?',
        date: new Date('2026-03-11T10:05:00.000Z'),
        from: {
          value: [{ name: 'Main Agent', address: 'agent@example.com' }],
        },
        to: {
          value: [{ name: 'Finance Ops', address: 'finance@example.com' }],
        },
        cc: undefined,
        bcc: undefined,
        replyTo: undefined,
        references: ['<msg-44@example.com>'],
        inReplyTo: '<msg-44@example.com>',
        headers: new Map<string, string>(),
        text: 'Reply sent from the agent.',
        attachments: [],
      },
    ],
  ]);
  const mockClient = {
    mailbox: { path: 'INBOX' },
    connect: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
    close: vi.fn(() => {}),
    list,
    getMailboxLock: vi.fn(async (path: string) => {
      mockClient.mailbox = { path };
      return { path, release: path === 'Sent' ? sentRelease : inboxRelease };
    }),
    search,
    fetchAll,
    fetchOne,
  };
  const MockImapFlow = vi.fn(function MockImapFlow() {
    return mockClient;
  });
  const simpleParser = vi.fn(async (source: Buffer) =>
    parsedMailBySource.get(source.toString('utf8')),
  );

  vi.doMock('imapflow', () => ({ ImapFlow: MockImapFlow }));
  vi.doMock('mailparser', () => ({ simpleParser }));

  const { fetchLiveAdminEmailMessage } = await import(
    '../src/channels/email/admin-mailbox.js'
  );

  const message = await fetchLiveAdminEmailMessage(
    BASE_EMAIL_CONFIG,
    'secret',
    {
      folder: 'INBOX',
      uid: 44,
    },
  );

  expect(message.thread).toMatchObject([
    {
      folder: 'INBOX',
      uid: 44,
      text: 'Inbound message.',
    },
    {
      folder: 'Sent',
      uid: 51,
      text: 'Reply sent from the agent.',
      metadata: {
        agentId: 'main',
        model: 'openai-codex/gpt-5.4',
        provider: 'openai-codex',
        totalTokens: 1234,
        tokenSource: null,
      },
    },
  ]);
  expect(search).toHaveBeenCalledWith(
    { header: { 'in-reply-to': '<msg-44@example.com>' } },
    { uid: true },
  );
  expect(sentRelease).toHaveBeenCalledTimes(1);
});

test('includes synthetic sent messages from session history when IMAP is missing them', async () => {
  mockAdminMailboxDb({
    sessions: [
      {
        id: 'email:finance@example.com',
        session_key:
          'agent:main:channel:email:chat:dm:peer:finance%40example.com',
        main_session_key:
          'agent:main:channel:email:chat:dm:peer:finance%40example.com',
        is_current: 1,
        legacy_session_id: 'email:finance@example.com',
        guild_id: null,
        channel_id: 'finance@example.com',
        agent_id: 'main',
        chatbot_id: null,
        model: 'hybridai/gpt-5.4-nano',
        enable_rag: 0,
        message_count: 3,
        session_summary: null,
        summary_updated_at: null,
        compaction_count: 0,
        memory_flush_at: null,
        full_auto_enabled: 0,
        full_auto_prompt: null,
        full_auto_started_at: null,
        show_mode: 'all',
        created_at: '2026-03-11T09:00:00.000Z',
        last_active: '2026-03-11T10:05:10.000Z',
        reset_count: 0,
        reset_at: null,
      },
    ],
    messages: [
      {
        id: 1001,
        session_id: 'email:finance@example.com',
        user_id: 'assistant',
        username: null,
        role: 'assistant',
        content: '[Subject: Re: Hej, wie läufts?]\n\nHi there',
        created_at: '2026-03-11T09:59:30.000Z',
      },
      {
        id: 1002,
        session_id: 'email:finance@example.com',
        user_id: 'assistant',
        username: null,
        role: 'assistant',
        content: '__MESSAGE_SEND_HANDLED__',
        created_at: '2026-03-11T10:05:10.000Z',
      },
    ],
    usageEvents: [
      {
        sessionId: 'email:finance@example.com',
        agentId: 'main',
        model: 'hybridai/gpt-5.4-nano',
        totalTokens: 777,
        timestamp: '2026-03-11T09:59:31.000Z',
      },
      {
        sessionId: 'email:finance@example.com',
        agentId: 'main',
        model: 'hybridai/gpt-5.4-nano',
        totalTokens: 1234,
        timestamp: '2026-03-11T10:05:11.000Z',
      },
    ],
    structuredAudit: [
      {
        id: 1,
        session_id: 'email:finance@example.com',
        seq: 1,
        event_type: 'tool.call',
        timestamp: '2026-03-11T10:05:09.000Z',
        run_id: 'run-1',
        parent_run_id: null,
        payload: JSON.stringify({
          toolName: 'message',
          arguments: {
            action: 'send',
            content:
              '[Subject: Re: Hej, wie läufts?]\n\nFollow-up from message tool',
          },
        }),
        wire_hash: 'hash-1',
        wire_prev_hash: 'prev-hash-1',
        created_at: '2026-03-11T10:05:09.000Z',
      },
    ],
  });
  const release = vi.fn();
  const list = vi.fn(async () => [
    {
      path: 'INBOX',
      name: 'Inbox',
      flags: new Set<string>(),
      specialUse: '\\Inbox',
    },
    {
      path: 'Sent',
      name: 'Sent',
      flags: new Set<string>(),
      specialUse: '\\Sent',
    },
  ]);
  const search = vi.fn(async () => []);
  const fetchAll = vi.fn(async () => []);
  const fetchOne = vi.fn(async () => ({
    seq: 2,
    uid: 44,
    source: Buffer.from('raw message'),
    envelope: {
      messageId: '<msg-44@example.com>',
      subject: 'Hej, wie läufts?',
      from: [{ name: 'Finance Ops', address: 'finance@example.com' }],
      date: new Date('2026-03-11T10:00:00.000Z'),
    },
    internalDate: new Date('2026-03-11T10:00:00.000Z'),
    flags: new Set<string>(['\\Seen']),
    bodyStructure: { part: '1', type: 'text/plain' },
  }));
  const parsedMailBySource = new Map<string, unknown>([
    [
      'raw message',
      {
        messageId: '<msg-44@example.com>',
        subject: 'Hej, wie läufts?',
        date: new Date('2026-03-11T10:00:00.000Z'),
        from: {
          value: [{ name: 'Finance Ops', address: 'finance@example.com' }],
        },
        to: {
          value: [{ name: 'Agent', address: 'agent@example.com' }],
        },
        cc: undefined,
        bcc: undefined,
        replyTo: undefined,
        references: undefined,
        inReplyTo: undefined,
        headers: new Map<string, string>(),
        text: 'Inbound message.',
        attachments: [],
      },
    ],
  ]);
  const mockClient = {
    mailbox: { path: 'INBOX' },
    connect: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
    close: vi.fn(() => {}),
    list,
    getMailboxLock: vi.fn(async (path: string) => {
      mockClient.mailbox = { path };
      return { path, release };
    }),
    search,
    fetchAll,
    fetchOne,
  };
  const MockImapFlow = vi.fn(function MockImapFlow() {
    return mockClient;
  });
  const simpleParser = vi.fn(async (source: Buffer) =>
    parsedMailBySource.get(source.toString('utf8')),
  );

  vi.doMock('imapflow', () => ({ ImapFlow: MockImapFlow }));
  vi.doMock('mailparser', () => ({ simpleParser }));

  const { fetchLiveAdminEmailMessage } = await import(
    '../src/channels/email/admin-mailbox.js'
  );

  const message = await fetchLiveAdminEmailMessage(
    BASE_EMAIL_CONFIG,
    'secret',
    {
      folder: 'INBOX',
      uid: 44,
    },
  );

  expect(message.thread).toMatchObject([
    {
      folder: 'Sent',
      subject: 'Re: Hej, wie läufts?',
      text: 'Hi there',
      metadata: {
        agentId: 'main',
        model: 'hybridai/gpt-5.4-nano',
        provider: 'hybridai',
        totalTokens: 777,
        tokenSource: null,
      },
    },
    {
      folder: 'INBOX',
      uid: 44,
      text: 'Inbound message.',
    },
    {
      folder: 'Sent',
      subject: 'Re: Hej, wie läufts?',
      text: 'Follow-up from message tool',
      metadata: {
        agentId: 'main',
        model: 'hybridai/gpt-5.4-nano',
        provider: 'hybridai',
        totalTokens: 1234,
        tokenSource: null,
      },
    },
  ]);
});

test('lists synthetic sent messages from successful message-tool sends when IMAP Sent is missing them', async () => {
  mockAdminMailboxDb({
    sessions: [
      {
        id: 'sess-web-send',
        session_key: 'agent:main:channel:tui:chat:dm:peer:web',
        main_session_key: 'agent:main:channel:tui:chat:dm:peer:web',
        is_current: 1,
        legacy_session_id: 'sess-web-send',
        guild_id: null,
        channel_id: 'web',
        agent_id: 'main',
        chatbot_id: null,
        model: 'hybridai/gpt-4.1-mini',
        enable_rag: 0,
        message_count: 2,
        session_summary: null,
        summary_updated_at: null,
        compaction_count: 0,
        memory_flush_at: null,
        full_auto_enabled: 0,
        full_auto_prompt: null,
        full_auto_started_at: null,
        show_mode: 'all',
        created_at: '2026-04-09T16:03:14.000Z',
        last_active: '2026-04-09T17:00:14.000Z',
        reset_count: 0,
        reset_at: null,
      },
    ],
    messages: [
      {
        id: 2001,
        session_id: 'sess-web-send',
        user_id: 'user',
        username: 'Ben',
        role: 'user',
        content: 'Send email to eigenarbeit@gmail.com with "Hi there"',
        created_at: '2026-04-09T17:00:13.000Z',
      },
    ],
    usageEvents: [
      {
        sessionId: 'sess-web-send',
        agentId: 'main',
        model: 'hybridai/gpt-4.1-mini',
        totalTokens: 34095,
        timestamp: '2026-04-09T17:00:13.919Z',
      },
    ],
    structuredAudit: [
      {
        id: 9001,
        session_id: 'sess-web-send',
        seq: 1,
        event_type: 'tool.call',
        timestamp: '2026-04-09T17:00:13.902Z',
        run_id: 'run-1',
        parent_run_id: null,
        payload: JSON.stringify({
          type: 'tool.call',
          toolCallId: 'send-1',
          toolName: 'message',
          arguments: {
            action: 'send',
            to: '***EMAIL_REDACTED***',
            content: 'Hi there',
          },
        }),
        wire_hash: 'hash-a',
        wire_prev_hash: 'prev-a',
        created_at: '2026-04-09T17:00:13.902Z',
      },
      {
        id: 9002,
        session_id: 'sess-web-send',
        seq: 2,
        event_type: 'tool.result',
        timestamp: '2026-04-09T17:00:13.913Z',
        run_id: 'run-1',
        parent_run_id: null,
        payload: JSON.stringify({
          type: 'tool.result',
          toolCallId: 'send-1',
          toolName: 'message',
          isError: false,
        }),
        wire_hash: 'hash-b',
        wire_prev_hash: 'hash-a',
        created_at: '2026-04-09T17:00:13.913Z',
      },
      {
        id: 9003,
        session_id: 'sess-web-send',
        seq: 3,
        event_type: 'tool.call',
        timestamp: '2026-04-10T08:05:21.685Z',
        run_id: 'run-2',
        parent_run_id: null,
        payload: JSON.stringify({
          type: 'tool.call',
          toolCallId: 'send-2',
          toolName: 'message',
          arguments: {
            action: 'send',
            to: 'telegram:@benkoehler',
            content: 'HUHU',
          },
        }),
        wire_hash: 'hash-c',
        wire_prev_hash: 'hash-b',
        created_at: '2026-04-10T08:05:21.685Z',
      },
      {
        id: 9004,
        session_id: 'sess-web-send',
        seq: 4,
        event_type: 'tool.result',
        timestamp: '2026-04-10T08:05:21.698Z',
        run_id: 'run-2',
        parent_run_id: null,
        payload: JSON.stringify({
          type: 'tool.result',
          toolCallId: 'send-2',
          toolName: 'message',
          isError: false,
        }),
        wire_hash: 'hash-d',
        wire_prev_hash: 'hash-c',
        created_at: '2026-04-10T08:05:21.698Z',
      },
    ],
  });
  const release = vi.fn();
  const list = vi.fn(async () => [
    {
      path: 'Sent',
      name: 'Sent',
      flags: new Set<string>(),
      specialUse: '\\Sent',
      status: {
        messages: 0,
        unseen: 0,
      },
    },
  ]);
  const search = vi.fn(async () => []);
  const fetchAll = vi.fn(async () => []);
  const mockClient = {
    mailbox: { path: 'Sent' },
    connect: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
    close: vi.fn(() => {}),
    list,
    getMailboxLock: vi.fn(async (path: string) => {
      mockClient.mailbox = { path };
      return { path, release };
    }),
    search,
    fetchAll,
  };
  const MockImapFlow = vi.fn(function MockImapFlow() {
    return mockClient;
  });

  vi.doMock('imapflow', () => ({ ImapFlow: MockImapFlow }));

  const { fetchLiveAdminEmailFolder } = await import(
    '../src/channels/email/admin-mailbox.js'
  );

  const folder = await fetchLiveAdminEmailFolder(BASE_EMAIL_CONFIG, 'secret', {
    folder: 'Sent',
    limit: 20,
  });

  expect(folder.messages).toMatchObject([
    {
      folder: 'Sent',
      subject: 'HybridClaw',
      fromAddress: 'agent@example.com',
      preview: 'Hi there',
    },
  ]);
  expect(folder.messages).toHaveLength(1);
  expect(folder.messages[0]?.uid).toBeLessThan(0);
  expect(release).toHaveBeenCalledTimes(1);
});

test('opens synthetic sent messages and infers recipients from the user prompt when audit is redacted', async () => {
  mockAdminMailboxDb({
    sessions: [
      {
        id: 'sess-web-send',
        session_key: 'agent:main:channel:tui:chat:dm:peer:web',
        main_session_key: 'agent:main:channel:tui:chat:dm:peer:web',
        is_current: 1,
        legacy_session_id: 'sess-web-send',
        guild_id: null,
        channel_id: 'web',
        agent_id: 'main',
        chatbot_id: null,
        model: 'hybridai/gpt-4.1-mini',
        enable_rag: 0,
        message_count: 2,
        session_summary: null,
        summary_updated_at: null,
        compaction_count: 0,
        memory_flush_at: null,
        full_auto_enabled: 0,
        full_auto_prompt: null,
        full_auto_started_at: null,
        show_mode: 'all',
        created_at: '2026-04-09T16:03:14.000Z',
        last_active: '2026-04-09T17:00:14.000Z',
        reset_count: 0,
        reset_at: null,
      },
    ],
    messages: [
      {
        id: 2001,
        session_id: 'sess-web-send',
        user_id: 'user',
        username: 'Ben',
        role: 'user',
        content: 'Send email to eigenarbeit@gmail.com with "Hi there"',
        created_at: '2026-04-09T17:00:13.000Z',
      },
    ],
    usageEvents: [
      {
        sessionId: 'sess-web-send',
        agentId: 'main',
        model: 'hybridai/gpt-4.1-mini',
        totalTokens: 34095,
        timestamp: '2026-04-09T17:00:13.919Z',
      },
    ],
    structuredAudit: [
      {
        id: 9001,
        session_id: 'sess-web-send',
        seq: 1,
        event_type: 'tool.call',
        timestamp: '2026-04-09T17:00:13.902Z',
        run_id: 'run-1',
        parent_run_id: null,
        payload: JSON.stringify({
          type: 'tool.call',
          toolCallId: 'send-1',
          toolName: 'message',
          arguments: {
            action: 'send',
            to: '***EMAIL_REDACTED***',
            content: 'Hi there',
          },
        }),
        wire_hash: 'hash-a',
        wire_prev_hash: 'prev-a',
        created_at: '2026-04-09T17:00:13.902Z',
      },
      {
        id: 9002,
        session_id: 'sess-web-send',
        seq: 2,
        event_type: 'tool.result',
        timestamp: '2026-04-09T17:00:13.913Z',
        run_id: 'run-1',
        parent_run_id: null,
        payload: JSON.stringify({
          type: 'tool.result',
          toolCallId: 'send-1',
          toolName: 'message',
          isError: false,
        }),
        wire_hash: 'hash-b',
        wire_prev_hash: 'hash-a',
        created_at: '2026-04-09T17:00:13.913Z',
      },
    ],
  });
  const release = vi.fn();
  const list = vi.fn(async () => [
    {
      path: 'Sent',
      name: 'Sent',
      flags: new Set<string>(),
      specialUse: '\\Sent',
    },
  ]);
  const mockClient = {
    mailbox: { path: 'Sent' },
    connect: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
    close: vi.fn(() => {}),
    list,
    getMailboxLock: vi.fn(async (path: string) => {
      mockClient.mailbox = { path };
      return { path, release };
    }),
    fetchOne: vi.fn(),
  };
  const MockImapFlow = vi.fn(function MockImapFlow() {
    return mockClient;
  });

  vi.doMock('imapflow', () => ({ ImapFlow: MockImapFlow }));

  const { fetchLiveAdminEmailMessage } = await import(
    '../src/channels/email/admin-mailbox.js'
  );

  const message = await fetchLiveAdminEmailMessage(
    BASE_EMAIL_CONFIG,
    'secret',
    {
      folder: 'Sent',
      uid: -(2_000_000_000 + 9001),
    },
  );

  expect(message).toMatchObject({
    message: {
      folder: 'Sent',
      subject: 'HybridClaw',
      text: 'Hi there',
      to: [{ address: 'eigenarbeit@gmail.com' }],
      metadata: {
        agentId: 'main',
        model: 'hybridai/gpt-4.1-mini',
        provider: 'hybridai',
        totalTokens: 34095,
        tokenSource: null,
      },
    },
    thread: [
      {
        folder: 'Sent',
        text: 'Hi there',
      },
    ],
  });
});

test('moves a live IMAP message to the trash folder when deleting', async () => {
  mockAdminMailboxDb();
  const release = vi.fn();
  const list = vi.fn(async () => [
    {
      path: 'INBOX',
      name: 'Inbox',
      flags: new Set<string>(),
      specialUse: '\\Inbox',
    },
    {
      path: 'Trash',
      name: 'Trash',
      flags: new Set<string>(),
      specialUse: '\\Trash',
    },
  ]);
  const messageMove = vi.fn(async () => ({}));
  const mockClient = {
    connect: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
    close: vi.fn(() => {}),
    list,
    getMailboxLock: vi.fn(async () => ({ path: 'INBOX', release })),
    messageMove,
    messageDelete: vi.fn(async () => true),
  };
  const MockImapFlow = vi.fn(function MockImapFlow() {
    return mockClient;
  });

  vi.doMock('imapflow', () => ({ ImapFlow: MockImapFlow }));

  const { deleteLiveAdminEmailMessage } = await import(
    '../src/channels/email/admin-mailbox.js'
  );

  const result = await deleteLiveAdminEmailMessage(
    BASE_EMAIL_CONFIG,
    'secret',
    {
      folder: 'INBOX',
      uid: 44,
    },
  );

  expect(result).toEqual({
    deleted: true,
    targetFolder: 'Trash',
    permanent: false,
  });
  expect(messageMove).toHaveBeenCalledWith('44', 'Trash', { uid: true });
  expect(release).toHaveBeenCalledTimes(1);
});

test('permanently deletes a live IMAP message when already in trash', async () => {
  mockAdminMailboxDb();
  const release = vi.fn();
  const list = vi.fn(async () => [
    {
      path: 'Trash',
      name: 'Trash',
      flags: new Set<string>(),
      specialUse: '\\Trash',
    },
  ]);
  const messageDelete = vi.fn(async () => true);
  const mockClient = {
    connect: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
    close: vi.fn(() => {}),
    list,
    getMailboxLock: vi.fn(async () => ({ path: 'Trash', release })),
    messageMove: vi.fn(async () => ({})),
    messageDelete,
  };
  const MockImapFlow = vi.fn(function MockImapFlow() {
    return mockClient;
  });

  vi.doMock('imapflow', () => ({ ImapFlow: MockImapFlow }));

  const { deleteLiveAdminEmailMessage } = await import(
    '../src/channels/email/admin-mailbox.js'
  );

  const result = await deleteLiveAdminEmailMessage(
    BASE_EMAIL_CONFIG,
    'secret',
    {
      folder: 'Trash',
      uid: 44,
    },
  );

  expect(result).toEqual({
    deleted: true,
    targetFolder: null,
    permanent: true,
  });
  expect(messageDelete).toHaveBeenCalledWith('44', { uid: true });
  expect(release).toHaveBeenCalledTimes(1);
});
