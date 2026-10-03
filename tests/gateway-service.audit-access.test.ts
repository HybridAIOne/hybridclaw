import { expect, test } from 'vitest';

import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-audit-access-',
});

const WEB_CHAT = 'web-chat';
const OTHER_WEB_CHAT = 'other-web-chat';
const DISCORD_CHAT = 'discord-chat';
const DISCORD_PEER = 'discord-peer';
const DISCORD_CHANNEL = '123456789012345678';
// What a paired phone's token carries: chat actions, no admin ones.
const PHONE_ACTIONS = ['chat.send'];

async function load() {
  setupHome();
  const { initDatabase } = await import('../src/memory/db.ts');
  const { createFreshSessionInstance } = await import(
    '../src/memory/sessions.ts'
  );
  const { recordAuditEvent } = await import('../src/audit/audit-events.ts');
  const { flushAuditTrail } = await import('../src/audit/audit-trail.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  initDatabase({ quiet: true });

  const audit = (
    sessionId: string,
    args: string[],
    channelId: string,
    adminActions?: string[],
  ) =>
    handleGatewayCommand({
      sessionId,
      guildId: null,
      channelId,
      args: ['audit', ...args],
      adminActions,
    });

  // Each chat's session row exists before anything reads its audit.
  for (const [sessionId, channelId] of [
    [WEB_CHAT, 'web'],
    [OTHER_WEB_CHAT, 'web'],
    [DISCORD_CHAT, DISCORD_CHANNEL],
    [DISCORD_PEER, DISCORD_CHANNEL],
  ]) {
    await audit(sessionId, ['last'], channelId);
  }

  const recordSecret = async (sessionId: string) => {
    recordAuditEvent({
      sessionId,
      runId: `turn_${sessionId}`,
      event: { type: 'turn.start', turnIndex: 1, userInput: 'private' },
    });
    recordAuditEvent({
      sessionId,
      runId: `turn_${sessionId}`,
      event: {
        type: 'tool.result',
        toolName: `secret_tool_${sessionId}`,
        isError: false,
        durationMs: 5,
      },
    });
    recordAuditEvent({
      sessionId,
      runId: `turn_${sessionId}`,
      event: { type: 'turn.end', turnIndex: 1, finishReason: 'completed' },
    });
    await flushAuditTrail();
  };

  return { audit, recordSecret, createFreshSessionInstance };
}

test.each([
  ['recent events', [], `secret_tool_${WEB_CHAT}`],
  ['the last turn', ['--last'], `turn_${WEB_CHAT}`],
  ['a turn', ['--turn', '1'], `turn_${WEB_CHAT}`],
])('a chat reads %s of its own session', async (_label, flags, expected) => {
  const { audit, recordSecret } = await load();
  await recordSecret(WEB_CHAT);

  const result = await audit(
    WEB_CHAT,
    [WEB_CHAT, ...flags],
    'web',
    PHONE_ACTIONS,
  );

  expect(result.kind).toBe('info');
  expect(result.text).toContain(expected);
});

test('a chat reads the audit of its earlier session after a reset', async () => {
  const { audit, recordSecret, createFreshSessionInstance } = await load();
  await recordSecret(DISCORD_CHAT);
  const fresh = createFreshSessionInstance(DISCORD_CHAT).session;

  const result = await audit(fresh.id, [DISCORD_CHAT], DISCORD_CHANNEL);

  expect(result.kind).toBe('info');
  expect(result.text).toContain(`secret_tool_${DISCORD_CHAT}`);
});

test('a web chat reads another web chat of the same agent', async () => {
  const { audit, recordSecret } = await load();
  await recordSecret(WEB_CHAT);

  const result = await audit(
    OTHER_WEB_CHAT,
    [WEB_CHAT, '--last'],
    'web',
    PHONE_ACTIONS,
  );

  expect(result.kind).toBe('info');
  expect(result.text).toContain(`turn_${WEB_CHAT}`);
});

test.each([
  ['a Discord peer, another Discord chat', DISCORD_PEER, DISCORD_CHANNEL, DISCORD_CHAT],
  ['a Discord peer, a web chat', DISCORD_PEER, DISCORD_CHANNEL, WEB_CHAT],
  ['a phone, a Discord chat', WEB_CHAT, 'web', DISCORD_CHAT],
])('%s: cannot read its audit', async (_label, requester, channelId, target) => {
  const { audit, recordSecret } = await load();
  await recordSecret(target);
  const missing = await audit(requester, ['no-such-session'], channelId, PHONE_ACTIONS);

  for (const flags of [[], ['--last'], ['--turn', '1'], ['--run', `turn_${target}`]]) {
    const result = await audit(requester, [target, ...flags], channelId, PHONE_ACTIONS);

    expect(result.text).not.toContain(`secret_tool_${target}`);
    expect(result.text).not.toContain(`turn_${target}`);
    // The same answer as for a session that does not exist.
    expect(result.kind).toBe(missing.kind);
    expect(result.text).toBe(missing.text.replace('no-such-session', target));
  }
});

test('the local operator reads any session', async () => {
  const { audit, recordSecret } = await load();
  await recordSecret(DISCORD_CHAT);

  for (const [channelId, adminActions] of [
    ['tui', undefined],
    ['web', ['admin.audit.read']],
  ] as const) {
    const result = await audit(
      'operator',
      [DISCORD_CHAT, '--last'],
      channelId,
      adminActions ? [...adminActions] : undefined,
    );

    expect(result.kind).toBe('info');
    expect(result.text).toContain(`turn_${DISCORD_CHAT}`);
  }
});
