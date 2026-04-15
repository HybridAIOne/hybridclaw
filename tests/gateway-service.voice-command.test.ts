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
