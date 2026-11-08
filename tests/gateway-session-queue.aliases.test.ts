import { expect, test, vi } from 'vitest';
import { cleanupGatewayRuntime } from './helpers/gateway-test-setup.js';
import { useCleanMocks, useTempDir } from './test-utils.js';
const temp = useTempDir();
useCleanMocks({
  cleanup: cleanupGatewayRuntime,
  resetModules: true,
  unstubAllEnvs: true,
});
test('a session key and stored ID share one queue while other sessions can run', async () => {
  vi.stubEnv('HOME', temp());
  const db = await import('../src/memory/db.js');
  const { buildSessionKey } = await import('../src/session/session-key.js');
  db.initDatabase({ quiet: true });
  const key = buildSessionKey('main', 'web', 'dm', 'test-peer');
  const session = db.getOrCreateSession(key, null, 'web');
  const { gatewaySessionQueue } = await import(
    '../src/gateway/session-worker-release.js'
  );
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = gatewaySessionQueue.run(key, () => blocked);
  const secondTask = vi.fn(async () => {});
  const second = gatewaySessionQueue.run(session.id, secondTask);
  await gatewaySessionQueue.run('other-session', async () => {});
  expect(secondTask).not.toHaveBeenCalled();
  release();
  await Promise.all([first, second]);
  expect(secondTask).toHaveBeenCalledOnce();
});
