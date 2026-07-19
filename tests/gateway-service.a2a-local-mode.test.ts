import fs from 'node:fs';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-a2a-local-mode-',
  envVars: ['HYBRIDCLAW_DATA_DIR'],
});

test('persists and reports A2A protection modes from the admin service', async () => {
  const homeDir = setupHome();
  process.env.HYBRIDCLAW_DATA_DIR = homeDir;
  vi.resetModules();

  const { initDatabase } = await import('../src/memory/db.js');
  initDatabase({ quiet: true });
  const {
    getGatewayAdminA2ATrust,
    saveGatewayAdminA2AE2EERequired,
    saveGatewayAdminA2ALocalMode,
  } = await import('../src/gateway/gateway-service.js');

  expect(getGatewayAdminA2ATrust().localMode).toEqual({ enabled: false });
  expect(getGatewayAdminA2ATrust()).toMatchObject({
    identity: {
      e2eePublicKeyFingerprint: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      e2eePublicKeyJwk: { kty: 'OKP', crv: 'X25519' },
    },
    e2ee: { required: false },
  });

  const updated = saveGatewayAdminA2ALocalMode({
    enabled: true,
    actor: 'user_a',
  });

  expect(updated.localMode).toEqual({ enabled: true });
  const e2eeUpdated = saveGatewayAdminA2AE2EERequired({
    required: true,
    actor: 'user_a',
  });
  expect(e2eeUpdated.e2ee).toEqual({ required: true });
  const config = JSON.parse(
    fs.readFileSync(path.join(homeDir, 'config.json'), 'utf-8'),
  ) as {
    deployment?: {
      a2a_local_mode?: unknown;
      a2a_e2ee_required?: unknown;
    };
  };
  expect(config.deployment?.a2a_local_mode).toBe(true);
  expect(config.deployment?.a2a_e2ee_required).toBe(true);
});
