import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-secret-refresh-');
useCleanMocks({ resetModules: true, unstubAllEnvs: true });

async function setup(authToken: unknown = '') {
  const dataDir = makeTempDir();
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', dataDir);
  vi.stubEnv('HYBRIDCLAW_MASTER_KEY', 'a'.repeat(64));
  vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
  vi.stubEnv('TWILIO_AUTH_TOKEN', '');
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      voice: { twilio: { authToken } },
    }),
  );
  const secrets = await import('../src/security/runtime-secrets.js');
  const config = await import('../src/config/config.js');
  return { secrets, config };
}

test('notifies after resolving saved secrets, including unchanged reloads, and detaches', async () => {
  const { secrets, config } = await setup();
  const observed: string[] = [];
  const listener = vi.fn(() => {
    observed.push(config.TWILIO_AUTH_TOKEN);
  });
  const detach = config.onRuntimeSecretsRefresh(listener);
  const before = config.getConfigSnapshot();
  secrets.saveNamedRuntimeSecrets({ TWILIO_AUTH_TOKEN: 'test-key' });
  config.refreshRuntimeSecretsFromEnv();
  config.refreshRuntimeSecretsFromEnv();
  expect(observed).toEqual(['test-key', 'test-key']);
  expect(config.getConfigSnapshot()).toEqual(before);
  expect(listener.mock.calls).toEqual([[], []]);

  detach();
  config.refreshRuntimeSecretsFromEnv();
  expect(listener).toHaveBeenCalledTimes(2);
});

test('preserves a configured token when another secret is saved', async () => {
  const { secrets, config } = await setup('test-config-key');
  secrets.saveNamedRuntimeSecrets({ UNRELATED_SECRET: 'test-key' });
  config.refreshRuntimeSecretsFromEnv();
  expect(config.TWILIO_AUTH_TOKEN).toBe('test-config-key');
});

test('resolves configured secret references afresh after rotation and removal', async () => {
  const { secrets, config } = await setup({
    source: 'store',
    id: 'PHONE_TOKEN',
  });
  const runtimeConfig = await import('../src/config/runtime-config.js');
  secrets.saveNamedRuntimeSecrets({ PHONE_TOKEN: 'test-key' });
  runtimeConfig.reloadRuntimeConfig();
  expect(config.getConfigSnapshot().voice.twilio.authToken).toBe('test-key');

  secrets.saveNamedRuntimeSecrets({ PHONE_TOKEN: 'test-rotated-key' });
  config.refreshRuntimeSecretsFromEnv();
  expect(config.TWILIO_AUTH_TOKEN).toBe('test-rotated-key');
  secrets.saveNamedRuntimeSecrets({ PHONE_TOKEN: null });
  config.refreshRuntimeSecretsFromEnv();
  expect(config.TWILIO_AUTH_TOKEN).toBe('');
});

test('a failed refresh subscriber does not prevent other subscribers from running', async () => {
  const { config } = await setup();
  config.onRuntimeSecretsRefresh(() => {
    throw new Error('test subscriber failure');
  });
  const listener = vi.fn();
  config.onRuntimeSecretsRefresh(listener);
  expect(() => config.refreshRuntimeSecretsFromEnv()).not.toThrow();
  expect(listener).toHaveBeenCalledOnce();
});
