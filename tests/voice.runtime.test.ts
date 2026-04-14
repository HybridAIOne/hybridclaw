import { Readable } from 'node:stream';
import { afterEach, expect, test, vi } from 'vitest';
import { buildTwilioSignature } from '../src/channels/voice/security.js';

function makeFormRequest(params: {
  url: string;
  body: Record<string, string>;
  headers?: Record<string, string>;
}) {
  const encoded = new URLSearchParams(params.body).toString();
  return Object.assign(Readable.from([Buffer.from(encoded)]), {
    method: 'POST',
    url: params.url,
    headers: {
      host: 'voice.example.com',
      'content-type': 'application/x-www-form-urlencoded',
      ...params.headers,
    },
    socket: {
      remoteAddress: '127.0.0.1',
    },
  });
}

function makeResponse() {
  const headers: Record<string, string> = {};
  return {
    body: '',
    headers,
    headersSent: false,
    statusCode: 0,
    writableEnded: false,
    end(chunk?: unknown) {
      if (chunk != null) {
        this.body += Buffer.isBuffer(chunk)
          ? chunk.toString('utf8')
          : String(chunk);
      }
      this.headersSent = true;
      this.writableEnded = true;
    },
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../src/config/config.js');
  vi.doUnmock('../src/logger.js');
  vi.resetModules();
});

test('voice runtime module does not require config snapshot during import', async () => {
  vi.doMock('../src/config/config.js', () => ({
    GATEWAY_BASE_URL: '',
    TWILIO_AUTH_TOKEN: '',
    getConfigSnapshot: vi.fn(() => {
      throw new Error('getConfigSnapshot should not run during import');
    }),
  }));
  vi.doMock('../src/logger.js', () => ({
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
  }));

  await expect(import('../src/channels/voice/runtime.js')).resolves.toBeTruthy();
});

test('handleVoiceWebhook returns relay TwiML when voice runtime is available', async () => {
  const getConfigSnapshot = vi.fn(() => ({
    voice: {
      enabled: true,
      provider: 'twilio',
      twilio: {
        accountSid: 'AC123',
        authToken: '',
        fromNumber: '+14155550123',
      },
      relay: {
        ttsProvider: 'default',
        voice: '',
        transcriptionProvider: 'default',
        language: 'en-US',
        interruptible: true,
        welcomeGreeting: 'Hello! How can I help you today?',
      },
      webhookPath: '/voice',
      maxConcurrentCalls: 8,
    },
  }));

  vi.doMock('../src/config/config.js', () => ({
    GATEWAY_BASE_URL: '',
    TWILIO_AUTH_TOKEN: 'env-voice-token',
    getConfigSnapshot,
  }));
  vi.doMock('../src/logger.js', () => ({
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
  }));

  const { handleVoiceWebhook, initVoice, shutdownVoice } = await import(
    '../src/channels/voice/runtime.js'
  );
  await initVoice(async () => {});
  const body = {
    CallSid: 'CA123',
    From: '+15550001111',
    To: '+15550002222',
  };
  const signature = buildTwilioSignature({
    authToken: 'env-voice-token',
    url: 'https://voice.example.com/voice/webhook',
    values: body,
  });
  const req = makeFormRequest({
    url: '/voice/webhook',
    body,
    headers: {
      'x-forwarded-proto': 'https',
      'x-twilio-signature': signature,
    },
  });
  const res = makeResponse();

  const handled = await handleVoiceWebhook(
    req as never,
    res as never,
    new URL('http://voice.example.com/voice/webhook'),
  );

  expect(handled).toBe(true);
  expect(res.statusCode).toBe(200);
  expect(res.body).toContain('<ConversationRelay');

  await shutdownVoice();
});

test('handleVoiceWebhook hangs up cleanly when voice runtime is unavailable', async () => {
  const getConfigSnapshot = vi.fn(() => ({
    voice: {
      enabled: true,
      provider: 'twilio',
      twilio: {
        accountSid: 'AC123',
        authToken: '',
        fromNumber: '+14155550123',
      },
      relay: {
        ttsProvider: 'default',
        voice: '',
        transcriptionProvider: 'default',
        language: 'en-US',
        interruptible: true,
        welcomeGreeting: 'Hello! How can I help you today?',
      },
      webhookPath: '/voice',
      maxConcurrentCalls: 8,
    },
  }));

  vi.doMock('../src/config/config.js', () => ({
    GATEWAY_BASE_URL: '',
    TWILIO_AUTH_TOKEN: 'env-voice-token',
    getConfigSnapshot,
  }));
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  vi.doMock('../src/logger.js', () => ({ logger }));

  const { handleVoiceWebhook, shutdownVoice } = await import(
    '../src/channels/voice/runtime.js'
  );
  const body = {
    CallSid: 'CA999',
    From: '+15550001111',
    To: '+15550002222',
  };
  const signature = buildTwilioSignature({
    authToken: 'env-voice-token',
    url: 'https://voice.example.com/voice/webhook',
    values: body,
  });
  const req = makeFormRequest({
    url: '/voice/webhook',
    body,
    headers: {
      'x-forwarded-proto': 'https',
      'x-twilio-signature': signature,
    },
  });
  const res = makeResponse();

  const handled = await handleVoiceWebhook(
    req as never,
    res as never,
    new URL('http://voice.example.com/voice/webhook'),
  );

  expect(handled).toBe(true);
  expect(res.statusCode).toBe(200);
  expect(res.body).toContain('<Hangup />');
  expect(res.body).not.toContain('<ConversationRelay');
  expect(logger.warn).toHaveBeenCalledWith(
    expect.objectContaining({
      path: '/voice/webhook',
      runtimeInitialized: false,
      draining: false,
      hasMessageHandler: false,
    }),
    'Voice webhook rejected: runtime unavailable',
  );

  await shutdownVoice();
});

test('handleVoiceWebhook rejects duplicate Twilio webhook replays', async () => {
  const getConfigSnapshot = vi.fn(() => ({
    voice: {
      enabled: true,
      provider: 'twilio',
      twilio: {
        accountSid: 'AC123',
        authToken: '',
        fromNumber: '+14155550123',
      },
      relay: {
        ttsProvider: 'default',
        voice: '',
        transcriptionProvider: 'default',
        language: 'en-US',
        interruptible: true,
        welcomeGreeting: 'Hello! How can I help you today?',
      },
      webhookPath: '/voice',
      maxConcurrentCalls: 8,
    },
  }));

  vi.doMock('../src/config/config.js', () => ({
    GATEWAY_BASE_URL: '',
    TWILIO_AUTH_TOKEN: 'env-voice-token',
    getConfigSnapshot,
  }));
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  vi.doMock('../src/logger.js', () => ({ logger }));

  const { handleVoiceWebhook, initVoice, shutdownVoice } = await import(
    '../src/channels/voice/runtime.js'
  );
  await initVoice(async () => {});
  const body = {
    CallSid: 'CA-DUP-WEBHOOK',
    From: '+15550001111',
    To: '+15550002222',
  };
  const signature = buildTwilioSignature({
    authToken: 'env-voice-token',
    url: 'https://voice.example.com/voice/webhook',
    values: body,
  });
  const headers = {
    'x-forwarded-proto': 'https',
    'x-twilio-signature': signature,
    'i-twilio-idempotency-token': 'dup-webhook-token',
  };

  const firstRes = makeResponse();
  await handleVoiceWebhook(
    makeFormRequest({
      url: '/voice/webhook',
      body,
      headers,
    }) as never,
    firstRes as never,
    new URL('http://voice.example.com/voice/webhook'),
  );

  const replayRes = makeResponse();
  const handled = await handleVoiceWebhook(
    makeFormRequest({
      url: '/voice/webhook',
      body,
      headers,
    }) as never,
    replayRes as never,
    new URL('http://voice.example.com/voice/webhook'),
  );

  expect(handled).toBe(true);
  expect(replayRes.statusCode).toBe(409);
  expect(replayRes.body).toContain('<Hangup />');
  expect(replayRes.body).toContain('Duplicate Twilio voice request ignored.');
  expect(logger.warn).toHaveBeenCalledWith(
    expect.objectContaining({
      path: '/voice/webhook',
      replayToken: 'dup-webhook-token',
    }),
    'Voice webhook rejected: duplicate Twilio request',
  );

  await shutdownVoice();
});

test('handleVoiceWebhook rejects duplicate Twilio action callback replays', async () => {
  const getConfigSnapshot = vi.fn(() => ({
    voice: {
      enabled: true,
      provider: 'twilio',
      twilio: {
        accountSid: 'AC123',
        authToken: '',
        fromNumber: '+14155550123',
      },
      relay: {
        ttsProvider: 'default',
        voice: '',
        transcriptionProvider: 'default',
        language: 'en-US',
        interruptible: true,
        welcomeGreeting: 'Hello! How can I help you today?',
      },
      webhookPath: '/voice',
      maxConcurrentCalls: 8,
    },
  }));

  vi.doMock('../src/config/config.js', () => ({
    GATEWAY_BASE_URL: '',
    TWILIO_AUTH_TOKEN: 'env-voice-token',
    getConfigSnapshot,
  }));
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  vi.doMock('../src/logger.js', () => ({ logger }));

  const { handleVoiceWebhook, initVoice, shutdownVoice } = await import(
    '../src/channels/voice/runtime.js'
  );
  await initVoice(async () => {});
  const body = {
    CallSid: 'CA-DUP-ACTION',
    SessionId: 'VX123',
    SessionStatus: 'completed',
    CallStatus: 'completed',
  };
  const signature = buildTwilioSignature({
    authToken: 'env-voice-token',
    url: 'https://voice.example.com/voice/action',
    values: body,
  });
  const headers = {
    'x-forwarded-proto': 'https',
    'x-twilio-signature': signature,
    'i-twilio-idempotency-token': 'dup-action-token',
  };

  const firstRes = makeResponse();
  await handleVoiceWebhook(
    makeFormRequest({
      url: '/voice/action',
      body,
      headers,
    }) as never,
    firstRes as never,
    new URL('http://voice.example.com/voice/action'),
  );

  const replayRes = makeResponse();
  const handled = await handleVoiceWebhook(
    makeFormRequest({
      url: '/voice/action',
      body,
      headers,
    }) as never,
    replayRes as never,
    new URL('http://voice.example.com/voice/action'),
  );

  expect(handled).toBe(true);
  expect(replayRes.statusCode).toBe(409);
  expect(replayRes.body).toContain('<Hangup />');
  expect(replayRes.body).toContain('Duplicate Twilio voice request ignored.');
  expect(logger.warn).toHaveBeenCalledWith(
    expect.objectContaining({
      path: '/voice/action',
      replayToken: 'dup-action-token',
    }),
    'Voice action callback rejected: duplicate Twilio request',
  );

  await shutdownVoice();
});

test('handleVoiceWebhook warns once when the Twilio auth token is missing', async () => {
  const getConfigSnapshot = vi.fn(() => ({
    voice: {
      enabled: true,
      provider: 'twilio',
      twilio: {
        accountSid: 'AC123',
        authToken: '',
        fromNumber: '+14155550123',
      },
      relay: {
        ttsProvider: 'default',
        voice: '',
        transcriptionProvider: 'default',
        language: 'en-US',
        interruptible: true,
        welcomeGreeting: 'Hello! How can I help you today?',
      },
      webhookPath: '/voice',
      maxConcurrentCalls: 8,
    },
  }));

  vi.doMock('../src/config/config.js', () => ({
    GATEWAY_BASE_URL: '',
    TWILIO_AUTH_TOKEN: '',
    getConfigSnapshot,
  }));
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  vi.doMock('../src/logger.js', () => ({ logger }));

  const { handleVoiceWebhook, initVoice, shutdownVoice } = await import(
    '../src/channels/voice/runtime.js'
  );
  await initVoice(async () => {});

  const firstRes = makeResponse();
  await handleVoiceWebhook(
    makeFormRequest({
      url: '/voice/webhook',
      body: {
        CallSid: 'CA-NO-TOKEN-1',
        From: '+15550001111',
        To: '+15550002222',
      },
      headers: {
        'x-forwarded-proto': 'https',
        'x-twilio-signature': 'invalid',
      },
    }) as never,
    firstRes as never,
    new URL('http://voice.example.com/voice/webhook'),
  );

  const secondRes = makeResponse();
  await handleVoiceWebhook(
    makeFormRequest({
      url: '/voice/webhook',
      body: {
        CallSid: 'CA-NO-TOKEN-2',
        From: '+15550001111',
        To: '+15550002222',
      },
      headers: {
        'x-forwarded-proto': 'https',
        'x-twilio-signature': 'invalid',
      },
    }) as never,
    secondRes as never,
    new URL('http://voice.example.com/voice/webhook'),
  );

  expect(
    logger.warn.mock.calls.filter(
      ([message]) =>
        message ===
        'Voice runtime missing Twilio auth token; rejecting signed requests until configured.',
    ),
  ).toHaveLength(1);

  await shutdownVoice();
});
