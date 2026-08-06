import { createHash, createHmac, generateKeyPairSync } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, expect, test, vi } from 'vitest';

const SIGNATURE_SECRET = 'test-signature-secret-at-least-32-bytes-long';
const TEST_PRIVATE_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;

function signWebhook(rawBody: string): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iat: Math.floor(Date.now() / 1000),
      jti: `jti-${Math.random().toString(36).slice(2)}`,
      iss: 'Vonage',
      api_key: 'test-api-key',
      ...(rawBody
        ? {
            payload_hash: createHash('sha256')
              .update(rawBody, 'utf8')
              .digest('hex'),
          }
        : {}),
    }),
  ).toString('base64url');
  const signature = createHmac('sha256', SIGNATURE_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `Bearer ${header}.${payload}.${signature}`;
}

function makeJsonRequest(params: {
  url: string;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  method?: string;
}) {
  const rawBody = params.body ? JSON.stringify(params.body) : '';
  return {
    req: Object.assign(Readable.from(rawBody ? [Buffer.from(rawBody)] : []), {
      method: params.method ?? 'POST',
      url: params.url,
      headers: {
        host: 'voice.example.com',
        'content-type': 'application/json',
        'x-forwarded-proto': 'https',
        ...params.headers,
      } as Record<string, string>,
      socket: {
        remoteAddress: '127.0.0.1',
      },
    }),
  };
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

function mockVonageConfig(provider: 'twilio' | 'vonage' = 'vonage') {
  const getConfigSnapshot = vi.fn(() => ({
    voice: {
      enabled: true,
      provider,
      twilio: {
        accountSid: '',
        authToken: '',
        fromNumber: '',
      },
      vonage: {
        applicationId: 'app-123',
        privateKey: '',
        signatureSecret: '',
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
    VONAGE_PRIVATE_KEY: TEST_PRIVATE_KEY,
    VONAGE_SIGNATURE_SECRET: SIGNATURE_SECRET,
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
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock('../src/config/config.js');
  vi.doUnmock('../src/logger.js');
  vi.resetModules();
});

test('answer webhook with a valid signed callback returns greeting NCCO', async () => {
  mockVonageConfig();
  const { handleVoiceWebhook, initVoice, shutdownVoice } = await import(
    '../src/channels/voice/runtime.js'
  );
  await initVoice(async () => {});

  const body = {
    uuid: 'call-1',
    conversation_uuid: 'CON-1',
    from: '15550001111',
    to: '15550002222',
  };
  const { req } = makeJsonRequest({
    url: '/voice/answer',
    body,
    headers: { authorization: signWebhook(JSON.stringify(body)) },
  });
  const res = makeResponse();
  const handled = await handleVoiceWebhook(
    req as never,
    res as never,
    new URL('https://voice.example.com/voice/answer'),
  );
  expect(handled).toBe(true);
  expect(res.statusCode).toBe(200);
  const ncco = JSON.parse(res.body);
  expect(ncco[0]).toMatchObject({
    action: 'talk',
    text: 'Hello! How can I help you today?',
  });
  expect(ncco[1]).toMatchObject({
    action: 'input',
    eventUrl: ['https://voice.example.com/voice/input'],
  });
  await shutdownVoice();
});

test('Twilio-only paths respond 404 while the Vonage provider is active', async () => {
  mockVonageConfig();
  const { handleVoiceWebhook, initVoice, shutdownVoice } = await import(
    '../src/channels/voice/runtime.js'
  );
  await initVoice(async () => {});

  const { req } = makeJsonRequest({ url: '/voice/webhook', body: {} });
  const res = makeResponse();
  const handled = await handleVoiceWebhook(
    req as never,
    res as never,
    new URL('https://voice.example.com/voice/webhook'),
  );
  expect(handled).toBe(true);
  expect(res.statusCode).toBe(404);
  await shutdownVoice();
});

test('Vonage paths respond 404 while the Twilio provider is active', async () => {
  mockVonageConfig('twilio');
  const { handleVoiceWebhook, initVoice, shutdownVoice } = await import(
    '../src/channels/voice/runtime.js'
  );
  await initVoice(async () => {});

  const { req } = makeJsonRequest({ url: '/voice/answer', body: {} });
  const res = makeResponse();
  const handled = await handleVoiceWebhook(
    req as never,
    res as never,
    new URL('https://voice.example.com/voice/answer'),
  );
  expect(handled).toBe(true);
  expect(res.statusCode).toBe(404);
  await shutdownVoice();
});

test('answer webhook without a valid signature is rejected', async () => {
  mockVonageConfig();
  const { handleVoiceWebhook, initVoice, shutdownVoice } = await import(
    '../src/channels/voice/runtime.js'
  );
  await initVoice(async () => {});

  const { req } = makeJsonRequest({
    url: '/voice/answer',
    body: { uuid: 'call-1', from: '1', to: '2' },
  });
  const res = makeResponse();
  await handleVoiceWebhook(
    req as never,
    res as never,
    new URL('https://voice.example.com/voice/answer'),
  );
  expect(res.statusCode).toBe(401);
  await shutdownVoice();
});

test('input webhook dispatches the transcript and transfers the reply', async () => {
  mockVonageConfig();
  const fetchMock = vi.fn(
    async () => new Response(null, { status: 204 }),
  );
  vi.stubGlobal('fetch', fetchMock);

  const { handleVoiceWebhook, initVoice, shutdownVoice } = await import(
    '../src/channels/voice/runtime.js'
  );
  const seen: string[] = [];
  await initVoice(
    async (
      _sessionId,
      _guildId,
      _channelId,
      _userId,
      _username,
      content,
      _media,
      reply,
    ) => {
      seen.push(content);
      await reply('Sure, I can help with that.');
    },
  );

  const answerBody = {
    uuid: 'call-1',
    conversation_uuid: 'CON-1',
    from: '15550001111',
    to: '15550002222',
    region_url: 'https://api-eu-3.vonage.com',
  };
  const answer = makeJsonRequest({
    url: '/voice/answer',
    body: answerBody,
    headers: { authorization: signWebhook(JSON.stringify(answerBody)) },
  });
  await handleVoiceWebhook(
    answer.req as never,
    makeResponse() as never,
    new URL('https://voice.example.com/voice/answer'),
  );

  const inputBody = {
    uuid: 'call-1',
    conversation_uuid: 'CON-1',
    speech: { results: [{ text: 'what time is it', confidence: '0.95' }] },
  };
  const input = makeJsonRequest({
    url: '/voice/input',
    body: inputBody,
    headers: { authorization: signWebhook(JSON.stringify(inputBody)) },
  });
  const inputRes = makeResponse();
  await handleVoiceWebhook(
    input.req as never,
    inputRes as never,
    new URL('https://voice.example.com/voice/input'),
  );

  expect(inputRes.statusCode).toBe(200);
  const parkNcco = JSON.parse(inputRes.body);
  expect(parkNcco).toHaveLength(1);
  expect(parkNcco[0]).toMatchObject({ action: 'input' });

  await vi.waitFor(() => {
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  expect(seen).toEqual(['what time is it']);

  const [transferUrl, transferInit] = fetchMock.mock.calls[0] as unknown as [
    string,
    RequestInit,
  ];
  expect(transferUrl).toBe('https://api-eu-3.vonage.com/v1/calls/call-1');
  expect(transferInit.method).toBe('PUT');
  const transferBody = JSON.parse(String(transferInit.body));
  expect(transferBody.action).toBe('transfer');
  expect(transferBody.destination.type).toBe('ncco');
  expect(transferBody.destination.ncco[0]).toMatchObject({
    action: 'talk',
    text: 'Sure, I can help with that.',
  });
  expect(
    transferBody.destination.ncco[transferBody.destination.ncco.length - 1],
  ).toMatchObject({ action: 'input' });

  await shutdownVoice();
});

test('event webhook with a terminal status removes the session', async () => {
  mockVonageConfig();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 204 })),
  );
  const { handleVoiceWebhook, initVoice, shutdownVoice } = await import(
    '../src/channels/voice/runtime.js'
  );
  await initVoice(async () => {});

  const answerBody = { uuid: 'call-1', from: '1', to: '2' };
  const answer = makeJsonRequest({
    url: '/voice/answer',
    body: answerBody,
    headers: { authorization: signWebhook(JSON.stringify(answerBody)) },
  });
  await handleVoiceWebhook(
    answer.req as never,
    makeResponse() as never,
    new URL('https://voice.example.com/voice/answer'),
  );

  const eventBody = {
    uuid: 'call-1',
    conversation_uuid: 'CON-1',
    status: 'completed',
  };
  const event = makeJsonRequest({
    url: '/voice/event',
    body: eventBody,
    headers: { authorization: signWebhook(JSON.stringify(eventBody)) },
  });
  const eventRes = makeResponse();
  await handleVoiceWebhook(
    event.req as never,
    eventRes as never,
    new URL('https://voice.example.com/voice/event'),
  );
  expect(eventRes.statusCode).toBe(200);

  // The session is gone, so a follow-up transcript ends the call gracefully.
  const inputBody = {
    uuid: 'call-1',
    speech: { results: [{ text: 'hello', confidence: '0.9' }] },
  };
  const input = makeJsonRequest({
    url: '/voice/input',
    body: inputBody,
    headers: { authorization: signWebhook(JSON.stringify(inputBody)) },
  });
  const inputRes = makeResponse();
  await handleVoiceWebhook(
    input.req as never,
    inputRes as never,
    new URL('https://voice.example.com/voice/input'),
  );
  const ncco = JSON.parse(inputRes.body);
  expect(ncco[0]).toMatchObject({ action: 'talk' });
  expect(String(ncco[0].text)).toContain('unavailable');
  await shutdownVoice();
});
