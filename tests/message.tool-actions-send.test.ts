import { expect, test, vi } from 'vitest';

async function importFreshMessageToolActions() {
  vi.resetModules();

  const getWhatsAppAuthStatus = vi.fn(async () => ({ linked: true }));
  const sendToWhatsAppChat = vi.fn(async () => {});
  const sendWhatsAppMediaToChat = vi.fn(async () => {});
  const runDiscordToolAction = vi.fn(async () => ({
    ok: true,
    action: 'send',
    channelId: '123456789012345678',
    transport: 'discord',
  }));
  const enqueueProactiveMessage = vi.fn(() => ({ queued: 1, dropped: 0 }));
  const getSessionById = vi.fn((sessionId: string) =>
    sessionId === 'wa:test'
      ? { id: sessionId, channel_id: '491234567890@s.whatsapp.net' }
      : null,
  );
  const resolveAgentForRequest = vi.fn(() => ({ agentId: 'main' }));
  const agentWorkspaceDir = vi.fn(() => '/tmp/hybridclaw-agent-workspace');

  vi.doMock('../src/channels/whatsapp/auth.js', () => ({
    getWhatsAppAuthStatus,
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
    getWhatsAppAuthStatus,
    sendToWhatsAppChat,
    sendWhatsAppMediaToChat,
    runDiscordToolAction,
    enqueueProactiveMessage,
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
