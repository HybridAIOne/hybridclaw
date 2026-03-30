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
