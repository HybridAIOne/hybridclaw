import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
useCleanMocks({ unstubAllEnvs: true, resetModules: true });

test.each([false, true])(
  'Signal enabled=%s controls status CLI probing',
  async (enabled) => {
    const home = tempDir();
    vi.stubEnv('HOME', home);
    vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
    const config = JSON.parse(fs.readFileSync('config.example.json', 'utf8'));
    config.signal.enabled = enabled;
    config.ops.dbPath = path.join(home, 'test.db');
    fs.mkdirSync(path.join(home, '.hybridclaw'));
    fs.writeFileSync(
      path.join(home, '.hybridclaw/config.json'),
      JSON.stringify(config),
    );
    const pairing = await import('../src/channels/signal/pairing.js');
    const probe = vi
      .spyOn(pairing, 'getSignalCliAvailability')
      .mockReturnValue({
        available: false,
        path: 'signal-cli',
        version: null,
        error: 'spawn signal-cli ENOENT',
      });
    const db = await import('../src/memory/db.js');
    const { getGatewayStatus } = await import(
      '../src/gateway/gateway-service.js'
    );
    db.initDatabase({ quiet: true });
    try {
      const status = await getGatewayStatus({
        refreshProviderHealth: false,
        includeCoworkerLiveness: false,
      });
      expect(probe).toHaveBeenCalledTimes(enabled ? 1 : 0);
      expect(status.signal).toMatchObject({
        enabled,
        cliAvailable: enabled ? false : null,
        cliPath: enabled ? 'signal-cli' : null,
        cliVersion: null,
        cliError: enabled ? 'spawn signal-cli ENOENT' : null,
      });
    } finally {
      db.closeDatabase();
    }
  },
);
