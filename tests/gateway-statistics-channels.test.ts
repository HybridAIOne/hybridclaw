import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-statistics-channels-');
useCleanMocks({ resetModules: true, unstubAllEnvs: true });

test('statistics exposes the gateway classifier for every destination', async () => {
  const dataDir = makeTempDir();
  vi.stubEnv('HOME', dataDir);
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', dataDir);
  vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
  vi.resetModules();
  const db = await import('../src/memory/db.js');
  db.initDatabase({ dbPath: path.join(dataDir, 'test.db'), quiet: true });
  try {
    const targets = [
      ['signal:+14155551212', 'signal'],
      ['19:conversation@thread.tacv2', 'msteams'],
      ['a:personal-chat', 'msteams'],
      ['491234567890@s.whatsapp.net', 'whatsapp'],
      ['ops@example.com', 'email'],
      ['tui', 'tui'],
      ['web', 'web'],
      ['unknown', null],
    ] as const;
    for (const [index, [target]] of targets.entries()) {
      db.getOrCreateSession(`stats-${index}`, null, target);
    }
    const { getGatewayAdminStatistics } = await import('../src/gateway/gateway-statistics-service.js');
    const result = getGatewayAdminStatistics();
    for (const [target, kind] of targets) {
      expect(result.channels.find(row => row.channelId === target)).toMatchObject({ channelKind: kind, sessionCount: 1 });
    }
  } finally {
    db.closeDatabase();
  }
});
