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
  const getSessionById = vi.fn((sessionId: string) =>
    sessionId === 'wa:test'
      ? { id: sessionId, channel_id: '491234567890@s.whatsapp.net' }
      : sessionId === 'email:ops@example.com'
        ? { id: sessionId, channel_id: 'ops@example.com' }
        : sessionId === 'email:peer@example.com'
          ? { id: sessionId, channel_id: 'peer@example.com' }
          : sessionId === 'teams:dm:user-aad-id'
            ? { id: sessionId, channel_id: currentTeamsChannelId }
            : null,
  );
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
    setCurrentTeamsChannelId: (channelId: string) => {
      currentTeamsChannelId = channelId;
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
  });

  expect(state.sendToEmail).toHaveBeenCalledWith(
    'ops@example.com',
    '[Subject: Deploy complete]\n\nDeployment is complete.',
  );
  expect(result).toMatchObject({
    ok: true,
    action: 'send',
    channelId: 'ops@example.com',
    transport: 'email',
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
  });

  expect(state.sendEmailAttachmentTo).toHaveBeenCalledWith({
    to: 'ops@example.com',
    filePath: '/tmp/hybridclaw-agent-workspace/notes/report.pdf',
    body: 'attached report',
  });
  expect(result).toMatchObject({
    ok: true,
    action: 'send',
    channelId: 'ops@example.com',
    transport: 'email',
    attachmentCount: 1,
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
