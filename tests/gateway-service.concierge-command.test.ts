import { expect, test } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-concierge-command-',
});

test('concierge info reports config and on/off toggles persisted runtime state', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { getRuntimeConfig } = await import('../src/config/runtime-config.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const info = await handleGatewayCommand({
    sessionId: 'session-concierge-command-info',
    guildId: null,
    channelId: 'web',
    args: ['concierge', 'info'],
  });

  expect(info.kind).toBe('info');
  if (info.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${info.kind}`);
  }
  expect(info.text).toContain('Enabled: off');
  expect(info.text).toContain('Decision model: hybridai/gemini-3-flash');

  const enabled = await handleGatewayCommand({
    sessionId: 'session-concierge-command-info',
    guildId: null,
    channelId: 'web',
    args: ['concierge', 'on'],
  });

  expect(enabled.kind).toBe('plain');
  expect(enabled.text).toContain('Concierge routing enabled');
  expect(getRuntimeConfig().routing.concierge.enabled).toBe(true);

  const disabled = await handleGatewayCommand({
    sessionId: 'session-concierge-command-info',
    guildId: null,
    channelId: 'web',
    args: ['concierge', 'off'],
  });

  expect(disabled.kind).toBe('plain');
  expect(disabled.text).toContain('Concierge routing disabled');
  expect(getRuntimeConfig().routing.concierge.enabled).toBe(false);
});

test('concierge command updates the decision model and profile mappings', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { getRuntimeConfig } = await import('../src/config/runtime-config.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const modelResult = await handleGatewayCommand({
    sessionId: 'session-concierge-command-model',
    guildId: null,
    channelId: 'web',
    args: ['concierge', 'model', 'gpt-5'],
  });

  expect(modelResult.kind).toBe('plain');
  expect(modelResult.text).toContain('Concierge decision model set');
  expect(getRuntimeConfig().routing.concierge.model).toBe('gpt-5');

  const profileResult = await handleGatewayCommand({
    sessionId: 'session-concierge-command-model',
    guildId: null,
    channelId: 'web',
    args: ['concierge', 'profile', 'no_hurry', 'gpt-5-mini'],
  });

  expect(profileResult.kind).toBe('plain');
  expect(profileResult.text).toContain('Concierge profile `no_hurry` set');
  expect(getRuntimeConfig().routing.concierge.profiles.noHurry).toBe(
    'gpt-5-mini',
  );
});

test('concierge command rejects unknown profile names', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const result = await handleGatewayCommand({
    sessionId: 'session-concierge-command-invalid',
    guildId: null,
    channelId: 'web',
    args: ['concierge', 'profile', 'later'],
  });

  expect(result.kind).toBe('error');
  expect(result.text).toContain(
    'Usage: `concierge profile <asap|balanced|no_hurry> [model]`',
  );
});

test('concierge command rejects unknown model names', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { getRuntimeConfig } = await import('../src/config/runtime-config.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const invalidDecisionModel = await handleGatewayCommand({
    sessionId: 'session-concierge-command-unknown-model',
    guildId: null,
    channelId: 'web',
    args: ['concierge', 'model', 'definitely-not-a-real-model'],
  });

  expect(invalidDecisionModel.kind).toBe('error');
  expect(invalidDecisionModel.text).toContain(
    '`definitely-not-a-real-model` is not in the available models list.',
  );
  expect(getRuntimeConfig().routing.concierge.model).toBe('gemini-3-flash');

  const invalidProfileModel = await handleGatewayCommand({
    sessionId: 'session-concierge-command-unknown-model',
    guildId: null,
    channelId: 'web',
    args: ['concierge', 'profile', 'balanced', 'definitely-not-a-real-model'],
  });

  expect(invalidProfileModel.kind).toBe('error');
  expect(invalidProfileModel.text).toContain(
    '`definitely-not-a-real-model` is not in the available models list.',
  );
  expect(getRuntimeConfig().routing.concierge.profiles.balanced).toBe(
    'gpt-5-mini',
  );
});
