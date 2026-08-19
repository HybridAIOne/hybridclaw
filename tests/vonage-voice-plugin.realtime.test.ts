import { afterEach, expect, test, vi } from 'vitest';
import { buildRealtimeConnectNcco } from '../plugins/vonage-voice/src/ncco.js';
import { createVonageRealtimeStreams } from '../plugins/vonage-voice/src/realtime.js';

const CONFIG = {
  publicBaseUrl: 'https://voice.example.com',
  welcomeGreeting: 'Hello there!',
  language: 'en-US',
};

const CALL = { uuid: 'call-1', from: '+15550001111', to: '+15550002222' };

class FakeStreamSocket {
  readyState = 1;
  sent: Buffer[] = [];
  closeCode: number | null = null;
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: string, listener: (...args: unknown[]) => void): void {
    const existing = this.listeners.get(event) || [];
    existing.push(listener);
    this.listeners.set(event, existing);
  }

  send(data: Buffer): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    this.readyState = 3;
    this.closeCode = code ?? 1000;
    for (const listener of this.listeners.get('close') || []) {
      listener(this.closeCode, Buffer.alloc(0));
    }
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) || []) listener(...args);
  }
}

function createFakeSession() {
  return {
    handleCallerAudio: vi.fn(),
    handleDtmf: vi.fn(),
    close: vi.fn(),
    isOpen: true,
  };
}

function createApi(session = createFakeSession()) {
  return {
    api: {
      config: { agents: { defaultAgentId: 'main' } },
      createRealtimeVoiceSession: vi.fn(() => session),
      isRealtimeVoiceAvailable: () => true,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    },
    session,
  };
}

function createCtx(token: string | null, ws = new FakeStreamSocket()) {
  const url = new URL(
    `https://voice.example.com/api/plugin-webhooks/vonage-voice/stream${
      token ? `?token=${token}` : ''
    }`,
  );
  const rejections: Array<{ statusCode: number; message: string }> = [];
  const accept = vi.fn(async () => ws);
  return {
    ctx: {
      url,
      webhookName: 'stream',
      logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
      accept,
      reject: (statusCode: number, message: string) => {
        rejections.push({ statusCode, message });
      },
    },
    ws,
    accept,
    rejections,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

test('realtime connect NCCO points the call at the stream websocket', () => {
  const ncco = buildRealtimeConnectNcco({
    websocketUri: 'wss://voice.example.com/api/plugin-webhooks/vonage-voice/stream?token=abc',
    callUuid: 'call-1',
    language: 'en-US',
  }) as Array<Record<string, unknown>>;

  expect(ncco[0].action).toBe('connect');
  const endpoint = (ncco[0].endpoint as Array<Record<string, unknown>>)[0];
  expect(endpoint.type).toBe('websocket');
  expect(endpoint['content-type']).toBe('audio/l16;rate=8000');
  expect(endpoint.headers).toEqual({ callUuid: 'call-1' });
  expect(String(endpoint.uri)).toContain('?token=abc');
  // The trailing talk ends the call cleanly once the websocket leg closes.
  expect(ncco.at(-1)?.action).toBe('talk');
});

test('a minted token upgrades once and wires audio to the realtime session', async () => {
  const { api, session } = createApi();
  const streams = createVonageRealtimeStreams(api, CONFIG);

  const token = streams.mintStreamToken(CALL);
  expect(streams.websocketUri(token)).toBe(
    `wss://voice.example.com/api/plugin-webhooks/vonage-voice/stream?token=${token}`,
  );

  const { ctx, ws, accept } = createCtx(token);
  await streams.handleStreamUpgrade(ctx);
  expect(accept).toHaveBeenCalled();
  expect(api.createRealtimeVoiceSession).toHaveBeenCalledWith(
    expect.objectContaining({
      caller: { from: CALL.from, to: CALL.to },
      greeting: CONFIG.welcomeGreeting,
      session: expect.objectContaining({
        sessionId: 'agent:main:channel:voice:chat:dm:peer:call-1',
        channelId: 'voice:call-1',
        userId: CALL.from,
      }),
    }),
  );

  const frame = Buffer.alloc(320, 1);
  ws.emit('message', frame, true);
  expect(session.handleCallerAudio).toHaveBeenCalledWith(frame);

  // Text lifecycle frames are ignored.
  ws.emit('message', JSON.stringify({ event: 'websocket:connected' }), false);
  expect(session.handleCallerAudio).toHaveBeenCalledTimes(1);

  // Model audio goes out through the session's sendAudio seam.
  const sessionOptions = (
    api.createRealtimeVoiceSession as ReturnType<typeof vi.fn>
  ).mock.calls[0][0] as { sendAudio: (frame: Buffer) => void };
  sessionOptions.sendAudio(Buffer.alloc(320, 2));
  expect(ws.sent).toHaveLength(1);

  ws.close();
  expect(session.close).toHaveBeenCalled();

  // The token is single-use.
  const second = createCtx(token);
  await streams.handleStreamUpgrade(second.ctx);
  expect(second.rejections).toEqual([
    { statusCode: 401, message: 'Invalid stream token' },
  ]);
});

test('missing and expired tokens are rejected before accept', async () => {
  vi.useFakeTimers();
  const { api } = createApi();
  const streams = createVonageRealtimeStreams(api, CONFIG);

  const missing = createCtx(null);
  await streams.handleStreamUpgrade(missing.ctx);
  expect(missing.rejections[0]?.statusCode).toBe(401);
  expect(missing.accept).not.toHaveBeenCalled();

  const token = streams.mintStreamToken(CALL);
  vi.advanceTimersByTime(31_000);
  const stale = createCtx(token);
  await streams.handleStreamUpgrade(stale.ctx);
  expect(stale.rejections[0]?.statusCode).toBe(401);
});

test('a failed session start closes the accepted socket', async () => {
  const { api } = createApi();
  (api.createRealtimeVoiceSession as ReturnType<typeof vi.fn>)
    .mockImplementation(() => {
      throw new Error('Realtime voice requires an OpenAI API key.');
    });
  const streams = createVonageRealtimeStreams(api, CONFIG);
  const token = streams.mintStreamToken(CALL);

  const { ctx, ws } = createCtx(token);
  await streams.handleStreamUpgrade(ctx);
  expect(ws.closeCode).toBe(1011);
});

test('stop closes all active streams and invalidates tokens', async () => {
  const { api, session } = createApi();
  const streams = createVonageRealtimeStreams(api, CONFIG);
  const token = streams.mintStreamToken(CALL);
  const { ctx, ws } = createCtx(token);
  await streams.handleStreamUpgrade(ctx);
  const unusedToken = streams.mintStreamToken({ ...CALL, uuid: 'call-2' });

  streams.stop();

  expect(session.close).toHaveBeenCalled();
  expect(ws.readyState).toBe(3);
  const reuse = createCtx(unusedToken);
  await streams.handleStreamUpgrade(reuse.ctx);
  expect(reuse.rejections[0]?.statusCode).toBe(401);
});
