import { expect, test, vi } from 'vitest';

async function importFreshMessageToolActions() {
  vi.resetModules();

  const sendEmailAttachmentTo = vi.fn(async () => {});
  const sendToEmail = vi.fn(async () => {});
  const hasActiveMSTeamsSession = vi.fn(
    (sessionId: string) => sessionId === 'teams:dm:user-aad-id',
  );
  const getRecentMessages = vi.fn((sessionId: string, _limit?: number) =>
    sessionId === 'email:ops@example.com'
      ? [
          {
            id: 101,
            session_id: sessionId,
            user_id: 'ops@example.com',
            username: 'Ops',
            role: 'user',
            content: 'Can you confirm the deploy status?',
            created_at: '2026-03-13 18:00:00',
          },
          {
            id: 102,
            session_id: sessionId,
            user_id: 'assistant',
            username: null,
            role: 'assistant',
            content: 'Deployment completed successfully.',
            created_at: '2026-03-13 18:01:00',
          },
        ]
      : sessionId === 'email:peer@example.com'
        ? [
            {
              id: 201,
              session_id: sessionId,
              user_id: 'peer@example.com',
              username: 'Peer',
              role: 'user',
              content: 'Checking in.',
              created_at: '2026-03-13 19:00:00',
            },
          ]
        : [],
  );
  const getMemoryValue = vi.fn((sessionId: string, key: string) =>
    sessionId === 'teams:dm:user-aad-id' &&
    key === 'msteams:conversation-reference'
      ? {
          reference: {
            user: {
              id: 'user-aad-id',
              name: 'Dr. Benedikt Koehler',
            },
          },
        }
      : null,
  );
  const getWhatsAppAuthStatus = vi.fn(async () => ({ linked: true }));
  const sendToWhatsAppChat = vi.fn(async () => {});
  const sendWhatsAppMediaToChat = vi.fn(async () => {});
  const sendToActiveMSTeamsSession = vi.fn(async () => ({
    attachmentCount: 1,
    channelId: 'a:teams-current-conversation',
  }));
  const runDiscordToolAction = vi.fn(async () => ({
    ok: true,
    action: 'send',
    channelId: '123456789012345678',
    transport: 'discord',
  }));
  const enqueueProactiveMessage = vi.fn(() => ({ queued: 1, dropped: 0 }));
  let currentTeamsChannelId = 'a:teams-current-conversation';
  let knownTeamsSessions = [
    {
      id: 'teams:dm:user-aad-id',
      guild_id: null,
      channel_id: currentTeamsChannelId,
      last_active: '2026-03-13T19:00:00.000Z',
      created_at: '2026-03-13T18:00:00.000Z',
    },
  ];
  const getAllSessions = vi.fn(() => knownTeamsSessions);
  const getSessionById = vi.fn((sessionId: string) => {
    if (sessionId === 'wa:test') {
      return { id: sessionId, channel_id: '491234567890@s.whatsapp.net' };
    }
    if (sessionId === 'email:ops@example.com') {
      return { id: sessionId, channel_id: 'ops@example.com' };
    }
    if (sessionId === 'email:peer@example.com') {
      return { id: sessionId, channel_id: 'peer@example.com' };
    }
    return (
      knownTeamsSessions.find((session) => session.id === sessionId) || null
    );
  });
  const resolveAgentForRequest = vi.fn(() => ({ agentId: 'main' }));
  const agentWorkspaceDir = vi.fn(() => '/tmp/hybridclaw-agent-workspace');

  vi.doMock('../src/channels/whatsapp/auth.js', () => ({
    getWhatsAppAuthStatus,
  }));
  vi.doMock('../src/channels/email/runtime.js', () => ({
    sendEmailAttachmentTo,
    sendToEmail,
  }));
  vi.doMock('../src/channels/msteams/runtime.js', () => ({
    hasActiveMSTeamsSession,
    sendToActiveMSTeamsSession,
  }));
  vi.doMock('../src/channels/whatsapp/runtime.js', () => ({
    sendToWhatsAppChat,
    sendWhatsAppMediaToChat,
  }));
  vi.doMock('../src/channels/discord/runtime.js', () => ({
    runDiscordToolAction,
  }));
  vi.doMock('../src/memory/db.js', () => ({
    getAllSessions,
    getMemoryValue,
    enqueueProactiveMessage,
    getRecentMessages,
    getSessionById,
  }));
  vi.doMock('../src/agents/agent-registry.js', () => ({
    resolveAgentForRequest,
  }));
  vi.doMock('../src/infra/ipc.js', () => ({
    agentWorkspaceDir,
  }));

  const module = await import('../src/channels/message/tool-actions.js');
  return {
    ...module,
    sendEmailAttachmentTo,
    sendToEmail,
    getRecentMessages,
    getWhatsAppAuthStatus,
    sendToWhatsAppChat,
    sendWhatsAppMediaToChat,
    hasActiveMSTeamsSession,
    sendToActiveMSTeamsSession,
    runDiscordToolAction,
    enqueueProactiveMessage,
    getAllSessions,
    getMemoryValue,
    setCurrentTeamsChannelId: (channelId: string) => {
      currentTeamsChannelId = channelId;
      knownTeamsSessions = knownTeamsSessions.map((session) =>
        session.id === 'teams:dm:user-aad-id'
          ? { ...session, channel_id: channelId }
          : session,
      );
    },
    setKnownTeamsSessions: (
      sessions: Array<{
        id: string;
        guild_id: string | null;
        channel_id: string;
        last_active: string;
        created_at: string;
      }>,
    ) => {
      knownTeamsSessions = sessions;
    },
  };
}

test('send action routes WhatsApp jid targets through WhatsApp transport', async () => {
  const state = await importFreshMessageToolActions();

  const result = await state.runMessageToolAction({
    action: 'send',
    channelId: '491234567890@s.whatsapp.net',
    content: 'hello whatsapp',
  });

  expect(state.sendToWhatsAppChat).toHaveBeenCalledWith(
    '491234567890@s.whatsapp.net',
    'hello whatsapp',
  );
  expect(state.sendToEmail).not.toHaveBeenCalled();
  expect(state.runDiscordToolAction).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    ok: true,
    action: 'send',
    channelId: '491234567890@s.whatsapp.net',
    transport: 'whatsapp',
  });
});

test('send action normalizes WhatsApp phone numbers before delivery', async () => {
  const state = await importFreshMessageToolActions();

  const result = await state.runMessageToolAction({
    action: 'send',
    channelId: 'whatsapp:+49 123 456 7890',
    content: 'hello phone',
  });

  expect(state.sendToWhatsAppChat).toHaveBeenCalledWith(
    '491234567890@s.whatsapp.net',
    'hello phone',
  );
  expect(result).toMatchObject({
    ok: true,
    action: 'send',
    channelId: '491234567890@s.whatsapp.net',
    transport: 'whatsapp',
  });
});

test('send action routes WhatsApp uploads through WhatsApp media delivery', async () => {
  const state = await importFreshMessageToolActions();

  const result = await state.runMessageToolAction({
    action: 'send',
    sessionId: 'wa:test',
    channelId: '491234567890@s.whatsapp.net',
    content: 'caption',
    filePath: 'notes/image.png',
  });

  expect(state.sendWhatsAppMediaToChat).toHaveBeenCalledWith({
    jid: '491234567890@s.whatsapp.net',
    filePath: '/tmp/hybridclaw-agent-workspace/notes/image.png',
    caption: 'caption',
  });
  expect(state.sendToWhatsAppChat).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    ok: true,
    action: 'send',
    channelId: '491234567890@s.whatsapp.net',
    transport: 'whatsapp',
    attachmentCount: 1,
  });
});

test('send action queues local targets like tui', async () => {
  const state = await importFreshMessageToolActions();

  const result = await state.runMessageToolAction({
    action: 'send',
    channelId: 'tui',
    content: 'hello local',
  });

  expect(state.enqueueProactiveMessage).toHaveBeenCalledWith(
    'tui',
    'hello local',
    'message-tool',
    100,
  );
  expect(state.runDiscordToolAction).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    ok: true,
    action: 'send',
    channelId: 'tui',
    transport: 'local',
    note: 'Queued local delivery.',
  });
});

test('send action routes email targets through email transport', async () => {
  const state = await importFreshMessageToolActions();

  const result = await state.runMessageToolAction({
    action: 'send',
    channelId: 'ops@example.com',
    content: '[Subject: Deploy complete]\n\nDeployment is complete.',
    subject: 'Quarterly update',
    cc: ['finance@example.com'],
    bcc: ['audit@example.com'],
    inReplyTo: '<msg-1@example.com>',
    references: ['<ref-1@example.com>', '<msg-1@example.com>'],
  });

  expect(state.sendToEmail).toHaveBeenCalledWith(
    'ops@example.com',
    '[Subject: Deploy complete]\n\nDeployment is complete.',
    {
      subject: 'Quarterly update',
      cc: ['finance@example.com'],
      bcc: ['audit@example.com'],
      inReplyTo: '<msg-1@example.com>',
      references: ['<ref-1@example.com>', '<msg-1@example.com>'],
    },
  );
  expect(result).toMatchObject({
    ok: true,
    action: 'send',
    channelId: 'ops@example.com',
    transport: 'email',
    subject: 'Quarterly update',
    cc: ['finance@example.com'],
    bcc: ['audit@example.com'],
    inReplyTo: '<msg-1@example.com>',
    references: ['<ref-1@example.com>', '<msg-1@example.com>'],
  });
});

test('send action routes email attachments through email delivery', async () => {
  const state = await importFreshMessageToolActions();

  const result = await state.runMessageToolAction({
    action: 'send',
    sessionId: 'wa:test',
    channelId: 'email:ops@example.com',
    content: 'attached report',
    filePath: 'notes/report.pdf',
    subject: 'Quarterly update',
    cc: ['finance@example.com'],
    bcc: ['audit@example.com'],
    inReplyTo: '<msg-1@example.com>',
    references: ['<ref-1@example.com>', '<msg-1@example.com>'],
  });

  expect(state.sendEmailAttachmentTo).toHaveBeenCalledWith({
    to: 'ops@example.com',
    filePath: '/tmp/hybridclaw-agent-workspace/notes/report.pdf',
    body: 'attached report',
    subject: 'Quarterly update',
    cc: ['finance@example.com'],
    bcc: ['audit@example.com'],
    inReplyTo: '<msg-1@example.com>',
    references: ['<ref-1@example.com>', '<msg-1@example.com>'],
  });
  expect(result).toMatchObject({
    ok: true,
    action: 'send',
    channelId: 'ops@example.com',
    transport: 'email',
    attachmentCount: 1,
    subject: 'Quarterly update',
    cc: ['finance@example.com'],
    bcc: ['audit@example.com'],
    inReplyTo: '<msg-1@example.com>',
    references: ['<ref-1@example.com>', '<msg-1@example.com>'],
  });
});

test('send action routes current Teams conversation uploads through Teams delivery', async () => {
  const state = await importFreshMessageToolActions();

  const result = await state.runMessageToolAction({
    action: 'send',
    sessionId: 'teams:dm:user-aad-id',
    channelId: 'a:teams-current-conversation',
    content: 'attached screenshot',
    filePath: '.browser-artifacts/hybridclaw-homepage.png',
  });

  expect(state.sendToActiveMSTeamsSession).toHaveBeenCalledWith({
    sessionId: 'teams:dm:user-aad-id',
    text: 'attached screenshot',
    filePath:
      '/tmp/hybridclaw-agent-workspace/.browser-artifacts/hybridclaw-homepage.png',
  });
  expect(state.runDiscordToolAction).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    ok: true,
    action: 'send',
    channelId: 'a:teams-current-conversation',
    transport: 'msteams',
    attachmentCount: 1,
  });
});

test('send action prefers the active Teams conversation over accidental WhatsApp phone parsing', async () => {
  const state = await importFreshMessageToolActions();
  const teamsConversationId =
    'a:1kGkJSPQvo_Q8xlDCzSNM_Av-YwKUmk_rC9W5qj4EYjwWwuHiWR3XkIhfrUyZAAtw_OPfViF3CNzCdwcIhY2kaIzAvzM6S8to7TUFJa43RrWMboiazAcgSphCU1PBn2VP';
  state.setCurrentTeamsChannelId(teamsConversationId);
  state.sendToActiveMSTeamsSession.mockResolvedValue({
    attachmentCount: 1,
    channelId: teamsConversationId,
  });

  const result = await state.runMessageToolAction({
    action: 'send',
    sessionId: 'teams:dm:user-aad-id',
    channelId: teamsConversationId,
    filePath: '.browser-artifacts/hybridclaw-homepage.png',
  });

  expect(state.sendToActiveMSTeamsSession).toHaveBeenCalledWith({
    sessionId: 'teams:dm:user-aad-id',
    text: '',
    filePath:
      '/tmp/hybridclaw-agent-workspace/.browser-artifacts/hybridclaw-homepage.png',
  });
  expect(state.sendWhatsAppMediaToChat).not.toHaveBeenCalled();
  expect(state.sendToWhatsAppChat).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    ok: true,
    action: 'send',
    channelId: teamsConversationId,
    transport: 'msteams',
    attachmentCount: 1,
  });
});

test('read action routes explicit email targets through stored email history', async () => {
  const state = await importFreshMessageToolActions();

  const result = await state.runMessageToolAction({
    action: 'read',
    channelId: 'email:ops@example.com',
    limit: 10,
  });

  expect(state.getRecentMessages).toHaveBeenCalledWith(
    'email:ops@example.com',
    10,
  );
  expect(state.runDiscordToolAction).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    ok: true,
    action: 'read',
    channelId: 'ops@example.com',
    sessionId: 'email:ops@example.com',
    transport: 'email',
    count: 2,
  });
  expect(result.messages).toEqual([
    expect.objectContaining({
      id: 101,
      role: 'user',
      author: expect.objectContaining({
        address: 'ops@example.com',
        assistant: false,
      }),
    }),
    expect.objectContaining({
      id: 102,
      role: 'assistant',
      author: expect.objectContaining({
        address: null,
        assistant: true,
      }),
    }),
  ]);
});

test('read action uses current email session when channelId is omitted', async () => {
  const state = await importFreshMessageToolActions();

  const result = await state.runMessageToolAction({
    action: 'read',
    sessionId: 'email:peer@example.com',
    limit: 5,
  });

  expect(state.getRecentMessages).toHaveBeenCalledWith(
    'email:peer@example.com',
    5,
  );
  expect(state.runDiscordToolAction).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    ok: true,
    action: 'read',
    channelId: 'peer@example.com',
    sessionId: 'email:peer@example.com',
    transport: 'email',
    count: 1,
  });
});

test('read action routes current Teams sessions through stored Teams history', async () => {
  const state = await importFreshMessageToolActions();

  state.getRecentMessages.mockImplementationOnce((sessionId: string) =>
    sessionId === 'teams:dm:user-aad-id'
      ? [
          {
            id: 301,
            session_id: sessionId,
            user_id: 'user-aad-id',
            username: 'Dr. Benedikt Koehler',
            role: 'user',
            content: 'What did I send earlier?',
            created_at: '2026-03-13 20:00:00',
          },
        ]
      : [],
  );

  const result = await state.runMessageToolAction({
    action: 'read',
    sessionId: 'teams:dm:user-aad-id',
    limit: 5,
  });

  expect(state.getRecentMessages).toHaveBeenCalledWith(
    'teams:dm:user-aad-id',
    5,
  );
  expect(state.runDiscordToolAction).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    ok: true,
    action: 'read',
    sessionId: 'teams:dm:user-aad-id',
    channelId: 'a:teams-current-conversation',
    transport: 'msteams',
    count: 1,
  });
});

test('channel-info action returns Teams session metadata for the current chat', async () => {
  const state = await importFreshMessageToolActions();

  const result = await state.runMessageToolAction({
    action: 'channel-info',
    sessionId: 'teams:dm:user-aad-id',
  });

  expect(state.runDiscordToolAction).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    ok: true,
    action: 'channel-info',
    transport: 'msteams',
    channel: expect.objectContaining({
      id: 'a:teams-current-conversation',
      sessionId: 'teams:dm:user-aad-id',
      isDm: true,
      active: true,
      proactiveAvailable: true,
    }),
  });
});

test('member-info action resolves the current Teams DM peer from stored reference data', async () => {
  const state = await importFreshMessageToolActions();

  const result = await state.runMessageToolAction({
    action: 'member-info',
    sessionId: 'teams:dm:user-aad-id',
  });

  expect(state.runDiscordToolAction).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    ok: true,
    action: 'member-info',
    transport: 'msteams',
    userId: 'user-aad-id',
    member: expect.objectContaining({
      id: 'user-aad-id',
      displayName: 'Dr. Benedikt Koehler',
    }),
  });
});

test('send action can target a known Teams conversation by explicit conversation id', async () => {
  const state = await importFreshMessageToolActions();
  state.hasActiveMSTeamsSession.mockReturnValue(false);

  const result = await state.runMessageToolAction({
    action: 'send',
    sessionId: 'teams:dm:user-aad-id',
    channelId: 'a:teams-current-conversation',
    content: 'hello known teams chat',
  });

  expect(state.sendToActiveMSTeamsSession).toHaveBeenCalledWith({
    sessionId: 'teams:dm:user-aad-id',
    text: 'hello known teams chat',
    filePath: null,
  });
  expect(state.runDiscordToolAction).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    ok: true,
    action: 'send',
    sessionId: 'teams:dm:user-aad-id',
    channelId: 'a:teams-current-conversation',
    transport: 'msteams',
  });
});

test('send action rejects Teams cross-session proactive sends', async () => {
  const state = await importFreshMessageToolActions();
  state.setKnownTeamsSessions([
    {
      id: 'teams:dm:user-aad-id',
      guild_id: null,
      channel_id: 'a:teams-current-conversation',
      last_active: '2026-03-13T19:00:00.000Z',
      created_at: '2026-03-13T18:00:00.000Z',
    },
    {
      id: 'teams:dm:other-user',
      guild_id: null,
      channel_id: 'a:other-teams-conversation',
      last_active: '2026-03-13T19:05:00.000Z',
      created_at: '2026-03-13T18:05:00.000Z',
    },
  ]);

  await expect(
    state.runMessageToolAction({
      action: 'send',
      sessionId: 'teams:dm:user-aad-id',
      channelId: 'teams:dm:other-user',
      content: 'hello from the wrong session',
    }),
  ).rejects.toThrow(
    'Teams send is only allowed to the current Teams session. Cross-session proactive Teams sends are not authorized.',
  );
  expect(state.sendToActiveMSTeamsSession).not.toHaveBeenCalled();
});

test('read action does not fall back to current email thread for discord channel targets', async () => {
  const state = await importFreshMessageToolActions();

  const result = await state.runMessageToolAction({
    action: 'read',
    sessionId: 'email:peer@example.com',
    channelId: '#dev',
    guildId: '1412305846125203539',
    limit: 50,
  });

  expect(state.getRecentMessages).not.toHaveBeenCalled();
  expect(state.runDiscordToolAction).toHaveBeenCalledWith({
    action: 'read',
    sessionId: 'email:peer@example.com',
    channelId: '#dev',
    guildId: '1412305846125203539',
    limit: 50,
  });
  expect(result).toMatchObject({
    ok: true,
    transport: 'discord',
  });
});

test('send action rejects unsupported local attachments', async () => {
  const state = await importFreshMessageToolActions();

  await expect(
    state.runMessageToolAction({
      action: 'send',
      channelId: 'tui',
      content: 'hello local',
      filePath: 'notes/image.png',
    }),
  ).rejects.toThrow('filePath is not supported for local channel sends.');
});

test('send action rejects WhatsApp sends when WhatsApp is not linked', async () => {
  const state = await importFreshMessageToolActions();
  state.getWhatsAppAuthStatus.mockResolvedValue({ linked: false });

  await expect(
    state.runMessageToolAction({
      action: 'send',
      channelId: '491234567890@s.whatsapp.net',
      content: 'hello whatsapp',
    }),
  ).rejects.toThrow('WhatsApp is not linked.');
  expect(state.sendToWhatsAppChat).not.toHaveBeenCalled();
});

test('non-send actions still delegate to Discord tool actions', async () => {
  const state = await importFreshMessageToolActions();

  const result = await state.runMessageToolAction({
    action: 'read',
    channelId: '123456789012345678',
    limit: 10,
  });

  expect(state.runDiscordToolAction).toHaveBeenCalledWith({
    action: 'read',
    channelId: '123456789012345678',
    limit: 10,
  });
  expect(result).toMatchObject({
    ok: true,
    action: 'send',
    transport: 'discord',
  });
});
