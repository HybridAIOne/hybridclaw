import { expect, test } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-speech-command-',
});

test('speech shows a realtime status block', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const result = await handleGatewayCommand({
    sessionId: 'session-speech-status',
    guildId: null,
    channelId: 'web',
    args: ['speech'],
  });

  expect(result.kind).toBe('info');
  expect(result.title).toBe('Speech');
  expect(result.text).toContain('Realtime model: gpt-realtime');
  expect(result.text).toContain('speech provider auto|hybridai|openai');
});

test('speech provider persists a valid provider and rejects others', async () => {
  setupHome();

  const { getRuntimeConfig, updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  updateRuntimeConfig((draft) => {
    draft.speech.realtime.provider = 'auto';
  });

  const set = await handleGatewayCommand({
    sessionId: 'session-speech-provider',
    guildId: null,
    channelId: 'web',
    args: ['speech', 'provider', 'openai'],
  });

  expect(set.kind).toBe('plain');
  expect(set.text).toContain('Realtime speech provider set to `openai`');
  expect(getRuntimeConfig().speech.realtime.provider).toBe('openai');

  const rejected = await handleGatewayCommand({
    sessionId: 'session-speech-provider',
    guildId: null,
    channelId: 'web',
    args: ['speech', 'provider', 'bogus'],
  });

  expect(rejected.kind).toBe('error');
  expect(getRuntimeConfig().speech.realtime.provider).toBe('openai');
});

test('speech model and voice setters persist trimmed values', async () => {
  setupHome();

  const { getRuntimeConfig } = await import('../src/config/runtime-config.ts');
  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const modelResult = await handleGatewayCommand({
    sessionId: 'session-speech-model',
    guildId: null,
    channelId: 'web',
    args: ['speech', 'model', ' gpt-realtime-mini '],
  });
  expect(modelResult.kind).toBe('plain');
  expect(getRuntimeConfig().speech.realtime.model).toBe('gpt-realtime-mini');

  const voiceResult = await handleGatewayCommand({
    sessionId: 'session-speech-voice',
    guildId: null,
    channelId: 'web',
    args: ['speech', 'voice', 'cedar'],
  });
  expect(voiceResult.kind).toBe('plain');
  expect(voiceResult.text).toContain('set to `cedar`');
  expect(getRuntimeConfig().speech.realtime.voice).toBe('cedar');

  const missingValue = await handleGatewayCommand({
    sessionId: 'session-speech-voice',
    guildId: null,
    channelId: 'web',
    args: ['speech', 'voice'],
  });
  expect(missingValue.kind).toBe('error');
});

test('config get/set on the legacy voice.realtime keys redirects to speech.realtime', async () => {
  setupHome();

  const { getRuntimeConfig } = await import('../src/config/runtime-config.ts');
  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const setResult = await handleGatewayCommand({
    sessionId: 'session-legacy-realtime-set',
    guildId: null,
    channelId: 'web',
    args: ['config', 'set', 'voice.realtime.voice', 'cedar'],
  });

  expect(setResult.kind).toBe('error');
  expect(setResult.title).toBe('Config Key Moved');
  expect(setResult.text).toContain('speech.realtime.voice');
  expect(getRuntimeConfig().speech.realtime.voice).toBe('marin');

  const getResult = await handleGatewayCommand({
    sessionId: 'session-legacy-realtime-get',
    guildId: null,
    channelId: 'web',
    args: ['config', 'get', 'voice.realtime.provider'],
  });

  expect(getResult.kind).toBe('error');
  expect(getResult.title).toBe('Config Key Moved');
  expect(getResult.text).toContain('speech.realtime.provider');
});

test('speech command stays restricted to local sessions', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const result = await handleGatewayCommand({
    sessionId: 'session-speech-remote',
    guildId: 'guild-1',
    channelId: 'discord:channel-1',
    args: ['speech', 'provider', 'openai'],
  });

  expect(result.kind).toBe('error');
  expect(result.title).toBe('Speech Command Restricted');
});
