import { createHash, createHmac, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { expect, test, vi } from 'vitest';
import { createVonageRuntime } from '../plugins/vonage-voice/src/runtime.js';
import { useCleanMocks } from './test-utils.js';

useCleanMocks({ restoreAllMocks: true });

const SIGNATURE_SECRET = 'test-signature-secret-at-least-32-bytes-long';
const CALL_SESSION_ID = 'agent:main:channel:voice:chat:dm:peer:call-1';

function signedRequest(body: Record<string, unknown>) {
  const raw = JSON.stringify(body);
  const segment = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = segment({ alg: 'HS256', typ: 'JWT' });
  const payload = segment({
    iat: Math.floor(Date.now() / 1000),
    jti: randomUUID(),
    payload_hash: createHash('sha256').update(raw).digest('hex'),
  });
  const signature = createHmac('sha256', SIGNATURE_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return Object.assign(Readable.from([Buffer.from(raw)]), {
    headers: { authorization: `Bearer ${header}.${payload}.${signature}` },
  });
}

function createHarness(mode: 'turn' | 'realtime') {
  const api = {
    getDefaultAgentId: vi.fn(() => 'main'),
    isRealtimeVoiceAvailable: () => true,
    releaseSessionWorker: vi.fn(async () => true),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
  const runtime = createVonageRuntime(api, {
    applicationId: 'app-id',
    publicBaseUrl: 'https://voice.example.com',
    signatureSecret: SIGNATURE_SECRET,
    callerPolicy: 'open',
    allowFrom: [],
    mode,
    language: 'en-US',
    welcomeGreeting: 'Hello!',
    interruptible: true,
    maxConcurrentCalls: 5,
  });
  async function post(
    handler: 'handleAnswer' | 'handleEvent',
    body: Record<string, unknown>,
  ) {
    const res = {
      statusCode: 0,
      headersSent: false,
      setHeader: vi.fn(),
      end: vi.fn(),
    };
    await runtime[handler]({
      req: signedRequest(body),
      res,
      webhookName: handler,
      logger: api.logger,
    });
    return res;
  }
  return { api, post };
}

test.each([
  ['turn', 'completed'],
  ['turn', 'busy'],
  ['realtime', 'failed'],
  ['realtime', 'timeout'],
] as const)(
  'a %s call that reaches %s releases its worker once',
  async (mode, status) => {
    const { api, post } = createHarness(mode);
    await post('handleAnswer', { uuid: 'call-1', from: '+15550001111' });
    api.getDefaultAgentId.mockReturnValue('other');

    await post('handleEvent', { uuid: 'call-1', status: 'answered' });
    expect(api.releaseSessionWorker).not.toHaveBeenCalled();
    await post('handleEvent', { uuid: 'call-1', status });
    await post('handleEvent', { uuid: 'call-1', status: 'completed' });

    expect(api.releaseSessionWorker).toHaveBeenCalledExactlyOnceWith(
      CALL_SESSION_ID,
    );
  },
);

test('a terminal event for a call this runtime never answered releases nothing', async () => {
  const { api, post } = createHarness('turn');

  await post('handleEvent', { uuid: 'call-unknown', status: 'completed' });

  expect(api.releaseSessionWorker).not.toHaveBeenCalled();
});
