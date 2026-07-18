import { expect, test } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-secret-command-',
});

test('secret status reports metadata without exposing the stored value', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { saveNamedRuntimeSecrets } = await import(
    '../src/security/runtime-secrets.ts'
  );
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  saveNamedRuntimeSecrets({ API_TOKEN: 'test-secret-value' });

  const result = await handleGatewayCommand({
    sessionId: 'session-secret-status',
    guildId: null,
    channelId: 'tui',
    args: ['secret', 'status', 'API_TOKEN'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Secret Status');
  expect(result.text).toBe('Name: API_TOKEN\nStored: yes');
  expect(result.text).not.toContain('test-secret-value');
});

test('secret status remains local-only and the removed alias is rejected', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const removedAlias = await handleGatewayCommand({
    sessionId: 'session-secret-alias',
    guildId: null,
    channelId: 'web',
    args: ['secret', 'show', 'API_TOKEN'],
  });
  expect(removedAlias.kind).toBe('error');
  if (removedAlias.kind !== 'error') {
    throw new Error(`Unexpected result kind: ${removedAlias.kind}`);
  }
  expect(removedAlias.title).toBe('Usage');
  expect(removedAlias.text).toContain('secret status <name>');

  const remoteStatus = await handleGatewayCommand({
    sessionId: 'session-secret-remote',
    guildId: 'guild-1',
    channelId: 'discord-channel-1',
    args: ['secret', 'status', 'API_TOKEN'],
  });
  expect(remoteStatus.kind).toBe('error');
  if (remoteStatus.kind !== 'error') {
    throw new Error(`Unexpected result kind: ${remoteStatus.kind}`);
  }
  expect(remoteStatus.title).toBe('Secret Command Restricted');
  expect(remoteStatus.text).toContain(
    'only available from local TUI/web sessions',
  );
});
