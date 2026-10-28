import { expect, test } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const cleanup: (() => void)[] = [];
const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hy-follow-operator-',
  cleanup: () => {
    for (const end of cleanup.splice(0)) end();
  },
});

async function setup(kind: string, ownerToken = false) {
  setupHome();
  const db = await import('../src/memory/db.js');
  const track = await import('../src/tracking/track-store.js');
  const follow = await import('../src/tracking/follow-through.js');
  const commands = await import('../src/tracking/track-command.js');
  const turn = await import('../src/session/turn-user.js');
  const notifications = await import(
    '../src/gateway/web-notification-store.js'
  );
  const { resolveWebNotificationOperator } = await import(
    '../src/gateway/web-notification-routes.js'
  );
  db.initDatabase({ quiet: true });
  const operatorId = resolveWebNotificationOperator(
    kind,
    'account-a',
    'phone-a',
    ownerToken,
  )!;
  const session = db.getOrCreateSession('phone-home', null, 'web', 'hy');
  notifications.bindWebNotificationSession(session.id, operatorId);
  const command = (args: string[], operator = operatorId) =>
    commands.handleTrackCommand(
      {
        sessionId: session.id,
        guildId: null,
        channelId: 'web',
        userId: 'account-a',
        operatorId: operator,
        args,
      },
      session,
    );
  return {
    db,
    track,
    follow,
    turn,
    notifications,
    operatorId,
    session,
    command,
  };
}

test.each([
  ['master', false],
  ['apiToken', true],
  ['apiToken', false],
  ['session', false],
])(
  '%s owner=%s reads its overview and linked evidence with the authenticated operator',
  async (kind, ownerToken) => {
    const {
      db,
      track,
      follow,
      turn,
      notifications,
      operatorId,
      session,
      command,
    } = await setup(kind, ownerToken);
    cleanup.push(
      turn.beginTurnUser(session.id, 'account-a', undefined, operatorId),
    );
    const item = track.addTracked(
      session,
      { title: 'Arrange a visit' },
      'user',
    );
    expect(follow.verifiedTrackOwner(session)).toBe('account-a');
    expect(command(['track', 'overview', '--json'])).toMatchObject({
      kind: 'plain',
      text: expect.stringContaining('"items":[{'),
    });
    const source = db.getOrCreateSession('source-chat', null, 'web', 'hy');
    notifications.bindWebNotificationSession(source.id, operatorId);
    const { memoryService } = await import('../src/memory/memory-service.js');
    const messageId = memoryService.storeMessage({
      sessionId: source.id,
      userId: 'assistant',
      role: 'assistant',
      content: 'Prepared a result.',
      agentId: 'hy',
    });
    expect(
      follow.trackEvidence(session, {
        kind: 'message',
        session_id: source.id,
        message_id: messageId,
      }),
    ).toHaveProperty('message.content', 'Prepared a result.');
    expect(follow.getTracked(session, item.id).followThrough?.owner).toBe(
      'account-a',
    );
    notifications.deleteWebNotificationSession(source.id);
    notifications.bindWebNotificationSession(
      source.id,
      notifications.notificationOperatorId('apiToken:other'),
    );
    expect(() =>
      follow.trackEvidence(session, {
        kind: 'message',
        session_id: source.id,
        message_id: messageId,
      }),
    ).toThrow('not accessible');
  },
);

test('another operator cannot borrow the account ID to read a bound chat', async () => {
  const { command, notifications } = await setup('master');
  expect(
    command(
      ['track', 'overview', '--json'],
      notifications.notificationOperatorId('apiToken:other'),
    ),
  ).toMatchObject({ kind: 'error' });
});

test('overlapping turns with the same account and different operators fail closed and clean up independently', async () => {
  const { turn, session, operatorId } = await setup('master');
  const first = turn.beginTurnUser(
    session.id,
    'account-a',
    undefined,
    operatorId,
  );
  const second = turn.beginTurnUser(
    session.id,
    'account-a',
    undefined,
    'other-operator',
  );
  cleanup.push(first, second);
  expect(turn.currentTurnUser(session.id)).toBeUndefined();
  second();
  expect(turn.currentTurnUser(session.id)).toMatchObject({
    userId: 'account-a',
    operatorId,
  });
  first();
  expect(turn.currentTurnUser(session.id)).toBeUndefined();
});
