import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-voice-command-',
});

const ACCOUNT_SID = 'test-account-sid';
const CALL_SID = 'test-call-sid';

test('voice call creates an outbound Twilio call with the stored auth token', async () => {
  setupHome();

  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    expect(String(url)).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Calls.json`,
    );
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from(`${ACCOUNT_SID}:twilio-secret-token`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    });

    const params = new URLSearchParams(String(init?.body || ''));
    expect(params.get('To')).toBe('+4915123456789');
    expect(params.get('From')).toBe('+14155550123');
    expect(params.get('Url')).toBe(
      'https://voice.example.com/telephony/webhook',
    );
    expect(params.get('Method')).toBe('POST');

    return new Response(
      JSON.stringify({
        sid: CALL_SID,
        status: 'queued',
        to: '+4915123456789',
        from: '+14155550123',
      }),
      {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  });
  vi.stubGlobal('fetch', fetchMock);

  const { refreshRuntimeSecretsFromEnv } = await import(
    '../src/config/config.ts'
  );
  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  const { initDatabase } = await import('../src/memory/db.ts');
  const { saveNamedRuntimeSecrets } = await import(
    '../src/security/runtime-secrets.ts'
  );
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  updateRuntimeConfig((draft) => {
    draft.ops.gatewayBaseUrl = 'https://voice.example.com';
    draft.voice.enabled = true;
    draft.voice.provider = 'twilio';
    draft.voice.twilio.accountSid = ACCOUNT_SID;
    draft.voice.twilio.authToken = '';
    draft.voice.twilio.fromNumber = '+14155550123';
    draft.voice.webhookPath = '/telephony';
  });
  saveNamedRuntimeSecrets({ TWILIO_AUTH_TOKEN: 'twilio-secret-token' });
  refreshRuntimeSecretsFromEnv();

  const result = await handleGatewayCommand({
    sessionId: 'session-voice-command',
    guildId: null,
    channelId: 'web',
    args: ['voice', 'call', ' +49 151 2345 6789 '],
  });

  expect(result.kind).toBe('plain');
  expect(result.text).toContain('Calling +4915123456789');
  expect(result.text).toContain(CALL_SID);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('voice info is available from the local CLI gateway surface', async () => {
  setupHome();

  const { refreshRuntimeSecretsFromEnv } = await import(
    '../src/config/config.ts'
  );
  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  const { initDatabase } = await import('../src/memory/db.ts');
  const { saveNamedRuntimeSecrets } = await import(
    '../src/security/runtime-secrets.ts'
  );
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  updateRuntimeConfig((draft) => {
    draft.ops.gatewayBaseUrl = 'https://voice.example.com';
    draft.voice.enabled = true;
    draft.voice.provider = 'twilio';
    draft.voice.twilio.accountSid = ACCOUNT_SID;
    draft.voice.twilio.authToken = '';
    draft.voice.twilio.fromNumber = '+14155550123';
  });
  saveNamedRuntimeSecrets({ TWILIO_AUTH_TOKEN: 'twilio-secret-token' });
  refreshRuntimeSecretsFromEnv();

  const result = await handleGatewayCommand({
    sessionId: 'session-voice-command-cli-info',
    guildId: null,
    channelId: 'cli',
    args: ['voice', 'info'],
  });

  expect(result.kind).toBe('info');
  expect(result.text).toContain('Enabled: on');
  expect(result.text).toContain(
    'Webhook: https://voice.example.com/voice/webhook',
  );
});

test('voice call rejects localhost webhook base URLs before dialing', async () => {
  setupHome();

  const { refreshRuntimeSecretsFromEnv } = await import(
    '../src/config/config.ts'
  );
  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  const { initDatabase } = await import('../src/memory/db.ts');
  const { saveNamedRuntimeSecrets } = await import(
    '../src/security/runtime-secrets.ts'
  );
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  updateRuntimeConfig((draft) => {
    draft.ops.gatewayBaseUrl = 'http://127.0.0.1:9090';
    draft.voice.enabled = true;
    draft.voice.provider = 'twilio';
    draft.voice.twilio.accountSid = ACCOUNT_SID;
    draft.voice.twilio.authToken = '';
    draft.voice.twilio.fromNumber = '+14155550123';
  });
  saveNamedRuntimeSecrets({ TWILIO_AUTH_TOKEN: 'twilio-secret-token' });
  refreshRuntimeSecretsFromEnv();

  const result = await handleGatewayCommand({
    sessionId: 'session-voice-command-localhost',
    guildId: null,
    channelId: 'web',
    args: ['voice', 'call', '+14155551212'],
  });

  expect(result.kind).toBe('error');
  expect(result.title).toBe('Voice Webhook Not Public');
  expect(result.text).toContain('ops.gatewayBaseUrl');
});

test('voice info reports realtime provider, model, voice, and credential state', async () => {
  setupHome();

  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  updateRuntimeConfig((draft) => {
    draft.ops.gatewayBaseUrl = 'https://voice.example.com';
  });

  const result = await handleGatewayCommand({
    sessionId: 'session-voice-realtime-info',
    guildId: null,
    channelId: 'web',
    args: ['voice', 'info'],
  });

  expect(result.kind).toBe('info');
  expect(result.text).toContain('Realtime provider: auto (');
  expect(result.text).toContain('Realtime model: gpt-realtime');
  expect(result.text).toContain('Realtime voice: marin');
  expect(result.text).toContain('Realtime credential:');
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

test('voice command stays restricted to local sessions', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const result = await handleGatewayCommand({
    sessionId: 'session-voice-command-remote',
    guildId: 'guild-1',
    channelId: 'discord:channel-1',
    args: ['voice', 'call', '+14155551212'],
  });

  expect(result.kind).toBe('error');
  expect(result.title).toBe('Voice Command Restricted');
});
