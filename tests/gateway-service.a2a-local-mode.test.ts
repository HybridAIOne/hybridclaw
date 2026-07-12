import fs from 'node:fs';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-a2a-local-mode-',
  envVars: ['HYBRIDCLAW_DATA_DIR'],
});

test('persists and reports A2A local mode from the admin service', async () => {
  const homeDir = setupHome();
  process.env.HYBRIDCLAW_DATA_DIR = homeDir;
  vi.resetModules();

  const { initDatabase } = await import('../src/memory/db.js');
  initDatabase({ quiet: true });
  const { getGatewayAdminA2ATrust, saveGatewayAdminA2ALocalMode } =
    await import('../src/gateway/gateway-service.js');

  expect(getGatewayAdminA2ATrust().localMode).toEqual({ enabled: false });

  const updated = saveGatewayAdminA2ALocalMode({
    enabled: true,
    actor: 'user_a',
  });

  expect(updated.localMode).toEqual({ enabled: true });
  const config = JSON.parse(
    fs.readFileSync(path.join(homeDir, 'config.json'), 'utf-8'),
  ) as { deployment?: { a2a_local_mode?: unknown } };
  expect(config.deployment?.a2a_local_mode).toBe(true);
});
