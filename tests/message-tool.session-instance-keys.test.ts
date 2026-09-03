import { expect, test, vi } from 'vitest';

import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-msg-tool-instance-keys-',
});

// Exactly what buildSessionIdFromActivity() produces for a Teams 1:1 chat.
const TEAMS_DM_SESSION_KEY =
  'agent:main:channel:msteams:chat:dm:peer:user-aad-id';
const TEAMS_CONVERSATION_ID = 'a:1regression-teams-conversation';
const OTHER_TEAMS_DM_SESSION_KEY =
  'agent:main:channel:msteams:chat:dm:peer:other-aad-id';
const OTHER_TEAMS_CONVERSATION_ID = 'a:1regression-other-conversation';
const SLACK_DM_SESSION_KEY = 'agent:main:channel:slack:chat:dm:peer:u123abc';
const SLACK_CHANNEL_TARGET = 'slack:D123ABC';

async function importWithChannelMocks() {
  vi.resetModules();

  const sendToActiveMSTeamsSession = vi.fn(
    async (_params: Record<string, unknown>) => ({
      attachmentCount: 0,
      channelId: TEAMS_CONVERSATION_ID,
    }),
  );
  const sendToActiveSlackSession = vi.fn(async () => ({
    channelId: SLACK_CHANNEL_TARGET,
    attachmentCount: 0,
  }));
  const runDiscordToolAction = vi.fn(async () => ({ ok: true }));

  vi.doMock('../src/channels/msteams/runtime.js', () => ({
    hasActiveMSTeamsSession: vi.fn(() => true),
    sendToActiveMSTeamsSession,
  }));
  vi.doMock('../src/channels/discord/runtime.js', () => ({
    runDiscordToolAction,
  }));
  vi.doMock('../src/channels/slack/runtime.js', () => ({
    hasActiveSlackSession: vi.fn(() => true),
    sendToActiveSlackSession,
  }));
  vi.doMock('../src/channels/whatsapp/auth.js', () => ({
    getWhatsAppAuthStatus: vi.fn(async () => ({ linked: false })),
  }));
  vi.doMock('../src/channels/email/runtime.js', () => ({
    readEmailMailbox: vi.fn(),
    sendEmailAttachmentTo: vi.fn(),
    sendToEmail: vi.fn(),
  }));
  vi.doMock('../src/channels/line/auth.js', () => ({
    getLineAuthStatus: vi.fn(async () => ({ linked: false })),
  }));
  vi.doMock('../src/channels/signal/runtime.js', () => ({
    sendToSignalChat: vi.fn(),
  }));
  vi.doMock('../src/channels/threema/runtime.js', () => ({
    sendToThreemaChat: vi.fn(),
  }));
  vi.doMock('../src/channels/telegram/runtime.js', () => ({
    sendTelegramMediaToChat: vi.fn(),
    sendToTelegramChat: vi.fn(),
  }));
  vi.doMock('../src/channels/slack-webhook/runtime.js', () => ({
    sendToSlackWebhookTarget: vi.fn(),
  }));
  vi.doMock('../src/channels/discord-webhook/runtime.js', () => ({
    sendToDiscordWebhookTarget: vi.fn(),
  }));
  vi.doMock('../src/channels/whatsapp/runtime.js', () => ({
    sendToWhatsAppChat: vi.fn(),
    sendWhatsAppMediaToChat: vi.fn(),
  }));
  vi.doMock('../src/channels/line/runtime.js', () => ({
    sendToLineSelfChat: vi.fn(),
  }));

  const db = await import('../src/memory/db.ts');
  const toolActions = await import('../src/channels/message/tool-actions.js');
  return {
    db,
    toolActions,
    sendToActiveMSTeamsSession,
    sendToActiveSlackSession,
    runDiscordToolAction,
  };
}

test('Teams DM sessions get sess_* instance ids with the canonical key in session_key', async () => {
  setupHome();
  const { db } = await importWithChannelMocks();
  db.initDatabase({ quiet: true });

  // What the Teams inbound handler does before invoking the agent. The
  // gateway then runs the agent with session.id, so that instance id is the
  // sessionId the container auto-fills into message-tool calls.
  const session = db.getOrCreateSession(
    TEAMS_DM_SESSION_KEY,
    null,
    TEAMS_CONVERSATION_ID,
  );

  expect(session.session_key).toBe(TEAMS_DM_SESSION_KEY);
  expect(session.id).toMatch(/^sess_/);
});

test('message-tool send from a Teams instance-id session reaches the Teams runtime under the canonical key', async () => {
  setupHome();
  const { db, toolActions, sendToActiveMSTeamsSession, runDiscordToolAction } =
    await importWithChannelMocks();
  db.initDatabase({ quiet: true });

  const session = db.getOrCreateSession(
    TEAMS_DM_SESSION_KEY,
    null,
    TEAMS_CONVERSATION_ID,
  );

  // Variant 1: omit channelId, what the Teams prompt hints recommend.
  await toolActions.runMessageToolAction({
    action: 'send',
    sessionId: session.id,
    content: 'test excel is ready',
  });

  // Variant 2: target the current Teams chat explicitly.
  await toolActions.runMessageToolAction({
    action: 'send',
    sessionId: session.id,
    channelId: 'msteams:current',
    content: 'test excel is ready',
  });

  // Variant 3: target the Teams conversation id shown in the prompt hint.
  await toolActions.runMessageToolAction({
    action: 'send',
    sessionId: session.id,
    channelId: TEAMS_CONVERSATION_ID,
    content: 'test excel is ready',
  });

  expect(sendToActiveMSTeamsSession).toHaveBeenCalledTimes(3);
  for (const [params] of sendToActiveMSTeamsSession.mock.calls) {
    // The runtime keys its active-session map and stored conversation
    // references by the canonical session key, not the instance id.
    expect(params).toMatchObject({
      sessionId: TEAMS_DM_SESSION_KEY,
      text: 'test excel is ready',
    });
  }
  expect(runDiscordToolAction).not.toHaveBeenCalled();
});

test('Teams channel-info resolves activity and stored references via the canonical key', async () => {
  setupHome();
  const { db, toolActions } = await importWithChannelMocks();
  db.initDatabase({ quiet: true });

  const session = db.getOrCreateSession(
    TEAMS_DM_SESSION_KEY,
    null,
    TEAMS_CONVERSATION_ID,
  );
  // The Teams runtime persists the conversation reference under the
  // canonical key (buildSessionIdFromActivity output).
  db.setMemoryValue(TEAMS_DM_SESSION_KEY, 'msteams:conversation-reference', {
    channelId: TEAMS_CONVERSATION_ID,
    isDm: true,
    reference: { conversation: { id: TEAMS_CONVERSATION_ID } },
    replyStyle: 'top-level',
  });

  const result = await toolActions.runMessageToolAction({
    action: 'channel-info',
    sessionId: session.id,
    channelId: 'msteams:current',
  });

  expect(result).toMatchObject({
    ok: true,
    action: 'channel-info',
    transport: 'msteams',
    channel: {
      id: TEAMS_CONVERSATION_ID,
      sessionId: session.id,
      isDm: true,
      active: true,
      proactiveAvailable: true,
    },
  });
});

test('cross-session Teams sends stay rejected for instance-id sessions', async () => {
  setupHome();
  const { db, toolActions, sendToActiveMSTeamsSession } =
    await importWithChannelMocks();
  db.initDatabase({ quiet: true });

  const requester = db.getOrCreateSession(
    TEAMS_DM_SESSION_KEY,
    null,
    TEAMS_CONVERSATION_ID,
  );
  db.getOrCreateSession(
    OTHER_TEAMS_DM_SESSION_KEY,
    null,
    OTHER_TEAMS_CONVERSATION_ID,
  );

  await expect(
    toolActions.runMessageToolAction({
      action: 'send',
      sessionId: requester.id,
      channelId: OTHER_TEAMS_CONVERSATION_ID,
      content: 'proactive cross-session send',
    }),
  ).rejects.toThrow(/only allowed to the current Teams session/);
  expect(sendToActiveMSTeamsSession).not.toHaveBeenCalled();
});

test('legacy Teams rows with the canonical key as row id still send', async () => {
  setupHome();
  const { db, toolActions, sendToActiveMSTeamsSession } =
    await importWithChannelMocks();
  db.initDatabase({ quiet: true });

  // Recreate the pre-multi-session row shape: id === canonical key.
  db.withMemoryDatabase((database) =>
    database
      .prepare(
        `INSERT INTO sessions (id, session_key, main_session_key, is_current, guild_id, channel_id, agent_id)
         VALUES (?, ?, ?, 1, NULL, ?, 'main')`,
      )
      .run(
        TEAMS_DM_SESSION_KEY,
        TEAMS_DM_SESSION_KEY,
        TEAMS_DM_SESSION_KEY,
        TEAMS_CONVERSATION_ID,
      ),
  );

  const result = await toolActions.runMessageToolAction({
    action: 'send',
    sessionId: TEAMS_DM_SESSION_KEY,
    channelId: 'msteams:current',
    content: 'test excel is ready',
  });

  expect(sendToActiveMSTeamsSession).toHaveBeenCalledWith({
    sessionId: TEAMS_DM_SESSION_KEY,
    text: 'test excel is ready',
    filePath: null,
  });
  expect(result).toMatchObject({ ok: true, transport: 'msteams' });
});

test('message-tool send from a Slack instance-id session reaches the Slack runtime under the canonical key', async () => {
  setupHome();
  const { db, toolActions, sendToActiveSlackSession } =
    await importWithChannelMocks();
  db.initDatabase({ quiet: true });

  const session = db.getOrCreateSession(
    SLACK_DM_SESSION_KEY,
    null,
    SLACK_CHANNEL_TARGET,
  );
  expect(session.id).toMatch(/^sess_/);

  const result = await toolActions.runMessageToolAction({
    action: 'send',
    sessionId: session.id,
    channelId: 'slack:current',
    content: 'hello slack',
  });

  expect(sendToActiveSlackSession).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: SLACK_DM_SESSION_KEY,
      text: 'hello slack',
    }),
  );
  expect(result).toMatchObject({
    ok: true,
    transport: 'slack',
    sessionId: session.id,
  });
});
