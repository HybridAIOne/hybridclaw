import { expect, test, vi } from 'vitest';

import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-get-all-sessions-',
});

test('getAllSessions applies an optional cap and warns on truncation', async () => {
  setupHome();

  const { getAllSessions, getOrCreateSession, initDatabase } = await import(
    '../src/memory/db.ts'
  );

  initDatabase({ quiet: true });
  for (let index = 0; index < 1_001; index += 1) {
    getOrCreateSession(`session-cap-${index}`, null, `channel-cap-${index}`);
  }

  const writes: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);

  const sessions = getAllSessions({
    limit: 1_000,
    warnLabel: 'test getAllSessions',
  });

  stdoutSpy.mockRestore();

  expect(sessions).toHaveLength(1_000);
  const logOutput = writes.join('');
  expect(logOutput).toContain(
    'Session query hit safety cap; returning truncated results',
  );
  expect(logOutput).toContain('test getAllSessions');
  expect(logOutput).toContain('1000');
  expect(logOutput).toContain('1001');
});

test('getRecentSessionsForAgents applies a per-agent cap', async () => {
  setupHome();

  const { getOrCreateSession, getRecentSessionsForAgents, initDatabase } =
    await import('../src/memory/db.ts');

  initDatabase({ quiet: true });
  for (const agentId of ['main', 'ops']) {
    for (let index = 0; index < 3; index += 1) {
      getOrCreateSession(
        `session-${agentId}-${index}`,
        null,
        `channel-${agentId}-${index}`,
        agentId,
      );
    }
  }
  getOrCreateSession(
    'session-research-0',
    null,
    'channel-research-0',
    'research',
  );

  const sessions = getRecentSessionsForAgents(['main', 'ops'], 2);

  expect(sessions).toHaveLength(4);
  expect(
    sessions.filter((session) => session.agent_id === 'main'),
  ).toHaveLength(2);
  expect(sessions.filter((session) => session.agent_id === 'ops')).toHaveLength(
    2,
  );
  expect(sessions.map((session) => session.agent_id)).not.toContain('research');
});
