import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const ORIGINAL_HOME = process.env.HOME;

const makeTempHome = useTempDir('hybridclaw-gateway-session-switch-');

useCleanMocks({
  restoreAllMocks: true,
  cleanup: () => {
    if (ORIGINAL_HOME === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = ORIGINAL_HOME;
    }
  },
  resetModules: true,
});

const SESSION_KEY = 'agent:main:channel:msteams:chat:dm:peer:user-1';

async function seedSessionFixture() {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { initDatabase, getOrCreateSession } = await import(
    '../src/memory/db.ts'
  );
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  const session = getOrCreateSession(SESSION_KEY, null, 'a:1');
  memoryService.storeMessage({
    sessionId: session.id,
    userId: 'user-1',
    username: 'user',
    role: 'user',
    content: 'first conversation',
  });

  return { handleGatewayCommand, getOrCreateSession, session };
}

test('new rotates to a fresh session and keeps the previous instance', async () => {
  const fixture = await seedSessionFixture();

  const result = await fixture.handleGatewayCommand({
    sessionId: SESSION_KEY,
    guildId: null,
    channelId: 'a:1',
    userId: 'user-1',
    username: 'user',
    args: ['new'],
  });

  expect(result.kind).toBe('info');
  expect(result.text).toContain('preserved');
  const current = fixture.getOrCreateSession(SESSION_KEY, null, 'a:1');
  expect(current.id).not.toBe(fixture.session.id);
  expect(current.message_count).toBe(0);
});

test('new on a fresh session is a no-op', async () => {
  const fixture = await seedSessionFixture();

  await fixture.handleGatewayCommand({
    sessionId: SESSION_KEY,
    guildId: null,
    channelId: 'a:1',
    userId: 'user-1',
    username: 'user',
    args: ['new'],
  });
  const result = await fixture.handleGatewayCommand({
    sessionId: SESSION_KEY,
    guildId: null,
    channelId: 'a:1',
    userId: 'user-1',
    username: 'user',
    args: ['new'],
  });

  expect(result.text).toContain('already a fresh session');
});

test('sessions list and switch move between instances of this chat', async () => {
  const fixture = await seedSessionFixture();

  await fixture.handleGatewayCommand({
    sessionId: SESSION_KEY,
    guildId: null,
    channelId: 'a:1',
    userId: 'user-1',
    username: 'user',
    args: ['new'],
  });

  const listed = await fixture.handleGatewayCommand({
    sessionId: SESSION_KEY,
    guildId: null,
    channelId: 'a:1',
    userId: 'user-1',
    username: 'user',
    args: ['sessions', 'list'],
  });
  expect(listed.title).toBe('Sessions For This Chat');
  expect(listed.sessionSwitcher).toHaveLength(2);
  expect(listed.sessionSwitcher?.[0].isCurrent).toBe(true);
  expect(listed.sessionSwitcher?.[1].sessionId).toBe(fixture.session.id);

  const switched = await fixture.handleGatewayCommand({
    sessionId: SESSION_KEY,
    guildId: null,
    channelId: 'a:1',
    userId: 'user-1',
    username: 'user',
    args: ['sessions', 'switch', '2'],
  });
  expect(switched.title).toBe('Session Switched');
  expect(fixture.getOrCreateSession(SESSION_KEY, null, 'a:1').id).toBe(
    fixture.session.id,
  );
});

test('sessions switch rejects unknown targets', async () => {
  const fixture = await seedSessionFixture();

  const result = await fixture.handleGatewayCommand({
    sessionId: SESSION_KEY,
    guildId: null,
    channelId: 'a:1',
    userId: 'user-1',
    username: 'user',
    args: ['sessions', 'switch', 'sess_does_not_exist'],
  });

  expect(result.kind).toBe('error');
  expect(result.title).toBe('Switch Failed');
});
