import { afterEach, expect, test, vi } from 'vitest';
import type { RealtimeSocket } from '../src/channels/voice/openai-realtime.js';

const REALTIME_CONFIG = {
  provider: 'openai' as const,
  model: 'gpt-realtime',
  voice: 'marin',
  greeting: 'Hello from voice!',
  instructions: '',
};

class FakeRealtimeSocket implements RealtimeSocket {
  readyState = 1;
  url = '';
  sent: Array<Record<string, unknown>> = [];
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: string, listener: (...args: unknown[]) => void): void {
    const existing = this.listeners.get(event) || [];
    existing.push(listener);
    this.listeners.set(event, existing);
  }

  send(data: string, cb?: (error?: Error) => void): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
    cb?.();
  }

  close(): void {
    this.readyState = 3;
    for (const listener of this.listeners.get('close') || []) listener();
  }

  open(): void {
    for (const listener of this.listeners.get('open') || []) listener();
  }

  serverEvent(event: Record<string, unknown>): void {
    for (const listener of this.listeners.get('message') || []) {
      listener(JSON.stringify(event));
    }
  }

  sentOfType(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((event) => event.type === type);
  }
}

class FakeBrowserSocket {
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  closeCode: number | null = null;
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: string, listener: (...args: unknown[]) => void): void {
    const existing = this.listeners.get(event) || [];
    existing.push(listener);
    this.listeners.set(event, existing);
  }

  send(data: string, cb?: (error?: Error) => void): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
    cb?.();
  }

  close(code?: number): void {
    this.readyState = 3;
    this.closeCode = code ?? 1000;
    for (const listener of this.listeners.get('close') || []) listener();
  }

  clientFrame(frame: Record<string, unknown>): void {
    for (const listener of this.listeners.get('message') || []) {
      listener(JSON.stringify(frame));
    }
  }

  sentOfType(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((frame) => frame.type === type);
  }
}

const handleGatewayMessage = vi.fn(async (_request: unknown) => ({
  status: 'success' as const,
  result: 'You have **two** meetings today.',
  toolsUsed: [] as string[],
}));

const persistVoiceTranscript = vi.fn();

async function createConnection(params?: { apiKey?: string }) {
  vi.doMock('../src/config/config.js', () => ({
    OPENAI_API_KEY: params?.apiKey ?? 'test-key',
    HYBRIDAI_BASE_URL: 'https://hybridai.example',
    getConfigSnapshot: () => ({ voice: { realtime: REALTIME_CONFIG } }),
  }));
  vi.doMock('../src/config/runtime-config.js', () => ({
    getRuntimeConfig: () => ({}),
    resolveDefaultAgentId: () => 'main',
  }));
  vi.doMock('../src/gateway/gateway-chat-service.js', () => ({
    handleGatewayMessage,
  }));
  vi.doMock('../src/gateway/voice-transcript-store.js', () => ({
    persistVoiceTranscript,
    VOICE_MESSAGE_SOURCE: 'voice',
  }));
  vi.doMock('../src/logger.js', () => ({
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  }));
  const { WebchatVoiceConnection } = await import(
    '../src/gateway/webchat-voice.js'
  );
  const browser = new FakeBrowserSocket();
  const realtime = new FakeRealtimeSocket();
  const finished = vi.fn();
  new WebchatVoiceConnection({
    ws: browser as never,
    identity: { userId: 'user-1', username: 'Ada' },
    remoteIp: '127.0.0.1',
    onFinished: finished,
    socketFactory: (url) => {
      realtime.url = url;
      return realtime;
    },
  });
  return { browser, realtime, finished };
}

async function loadWebchatVoiceModule() {
  vi.doMock('../src/config/config.js', () => ({
    OPENAI_API_KEY: 'test-key',
    HYBRIDAI_BASE_URL: 'https://hybridai.example',
    getConfigSnapshot: () => ({ voice: { realtime: REALTIME_CONFIG } }),
  }));
  vi.doMock('../src/config/runtime-config.js', () => ({
    getRuntimeConfig: () => ({}),
    resolveDefaultAgentId: () => 'main',
  }));
  vi.doMock('../src/gateway/gateway-chat-service.js', () => ({
    handleGatewayMessage,
  }));
  vi.doMock('../src/gateway/voice-transcript-store.js', () => ({
    persistVoiceTranscript,
    VOICE_MESSAGE_SOURCE: 'voice',
  }));
  vi.doMock('../src/logger.js', () => ({
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  }));
  return import('../src/gateway/webchat-voice.js');
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  handleGatewayMessage.mockClear();
  persistVoiceTranscript.mockClear();
  vi.doUnmock('../src/config/config.js');
  vi.doUnmock('../src/config/runtime-config.js');
  vi.doUnmock('../src/gateway/gateway-chat-service.js');
  vi.doUnmock('../src/gateway/voice-transcript-store.js');
  vi.doUnmock('../src/logger.js');
  vi.resetModules();
});

test('start frame opens a PCM16 web realtime session and acks with ready', async () => {
  const { browser, realtime } = await createConnection();

  browser.clientFrame({ type: 'start' });
  realtime.open();

  const [sessionUpdate] = realtime.sentOfType('session.update');
  const session = sessionUpdate.session as Record<string, unknown>;
  const audio = session.audio as {
    input: { format: Record<string, unknown> };
    output: { format: Record<string, unknown> };
  };
  expect(audio.input.format).toEqual({ type: 'audio/pcm', rate: 24000 });
  expect(audio.output.format).toEqual({ type: 'audio/pcm', rate: 24000 });
  expect(String(session.instructions)).toContain('web console');

  const [ready] = browser.sentOfType('ready');
  expect(String(ready.sessionId)).toMatch(/^agent:main:channel:web:chat:dm:peer:/);
});

test('a valid canonical sessionId from the client is kept for consults', async () => {
  const { browser, realtime } = await createConnection();
  const sessionId = 'agent:main:channel:web:chat:dm:peer:abc123';

  browser.clientFrame({ type: 'start', sessionId, agentId: 'main' });
  realtime.open();

  const [ready] = browser.sentOfType('ready');
  expect(ready.sessionId).toBe(sessionId);

  realtime.serverEvent({
    type: 'response.function_call_arguments.done',
    call_id: 'call_1',
    name: 'consult_agent',
    arguments: JSON.stringify({ request: 'What is on my calendar?' }),
  });
  await flushAsync();

  expect(handleGatewayMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId,
      channelId: 'web',
      userId: 'user-1',
      content: 'What is on my calendar?',
      source: 'webchat.voice',
    }),
  );
  const outputs = realtime
    .sentOfType('conversation.item.create')
    .map((event) => event.item as Record<string, unknown>);
  // The reply is voice-formatted (markdown stripped) before going upstream.
  expect(outputs).toContainEqual(
    expect.objectContaining({
      call_id: 'call_1',
      output: 'You have two meetings today.',
    }),
  );
});

test('audio flows both ways and barge-in clears browser playback', async () => {
  const { browser, realtime } = await createConnection();
  browser.clientFrame({ type: 'start' });
  realtime.open();

  browser.clientFrame({ type: 'audio', payload: 'dGVzdA==' });
  expect(realtime.sentOfType('input_audio_buffer.append')).toEqual([
    { type: 'input_audio_buffer.append', audio: 'dGVzdA==' },
  ]);

  realtime.serverEvent({ type: 'response.created' });
  realtime.serverEvent({ type: 'response.output_audio.delta', delta: 'bXU=' });
  expect(browser.sentOfType('audio')).toEqual([
    { type: 'audio', payload: 'bXU=' },
  ]);

  realtime.serverEvent({ type: 'input_audio_buffer.speech_started' });
  expect(browser.sentOfType('clear')).toHaveLength(1);
  expect(realtime.sentOfType('response.cancel')).toHaveLength(1);
});

test('transcripts reach the browser with web roles', async () => {
  const { browser, realtime } = await createConnection();
  browser.clientFrame({ type: 'start' });
  realtime.open();

  realtime.serverEvent({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: 'What time is it?',
  });
  realtime.serverEvent({
    type: 'response.output_audio_transcript.done',
    transcript: 'It is noon.',
  });

  expect(browser.sentOfType('transcript')).toEqual([
    { type: 'transcript', role: 'user', text: 'What time is it?' },
    { type: 'transcript', role: 'assistant', text: 'It is noon.' },
  ]);
});

test('spoken turns persist into session history as voice messages', async () => {
  const { browser, realtime } = await createConnection();
  const sessionId = 'agent:main:channel:web:chat:dm:peer:abc123';
  browser.clientFrame({ type: 'start', sessionId, agentId: 'main' });
  realtime.open();

  realtime.serverEvent({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: 'What time is it?',
  });
  realtime.serverEvent({
    type: 'response.output_audio_transcript.done',
    transcript: 'It is noon.',
  });

  expect(persistVoiceTranscript.mock.calls.map(([params]) => params)).toEqual([
    expect.objectContaining({
      sessionId,
      channelId: 'web',
      agentId: 'main',
      userId: 'user-1',
      username: 'Ada',
      role: 'user',
      text: 'What time is it?',
    }),
    expect.objectContaining({
      sessionId,
      role: 'assistant',
      text: 'It is noon.',
    }),
  ]);
});

test('consult tool activity streams to the browser as consult frames', async () => {
  handleGatewayMessage.mockImplementationOnce(async (request: unknown) => {
    const req = request as {
      onToolProgress?: (event: {
        sessionId: string;
        toolName: string;
        phase: 'start' | 'finish';
      }) => void;
    };
    req.onToolProgress?.({
      sessionId: 'ignored',
      toolName: 'web_search',
      phase: 'start',
    });
    return {
      status: 'success' as const,
      result: 'Found it.',
      toolsUsed: ['web_search'],
    };
  });
  const { browser, realtime } = await createConnection();
  browser.clientFrame({ type: 'start' });
  realtime.open();

  realtime.serverEvent({
    type: 'response.function_call_arguments.done',
    call_id: 'call_1',
    name: 'consult_agent',
    arguments: JSON.stringify({ request: 'Find the doc' }),
  });
  await flushAsync();

  expect(browser.sentOfType('consult')).toEqual([
    { type: 'consult', label: 'web search' },
    { type: 'consult', label: null },
  ]);
});

test('malformed frames close the socket with a policy violation', async () => {
  const { browser, finished } = await createConnection();

  browser.clientFrame({ type: 'bogus' });

  expect(browser.sentOfType('error')).toHaveLength(1);
  expect(browser.closeCode).toBe(1008);
  expect(finished).toHaveBeenCalled();
});

test('stop ends the session and closes the upstream socket', async () => {
  const { browser, realtime, finished } = await createConnection();
  browser.clientFrame({ type: 'start' });
  realtime.open();

  browser.clientFrame({ type: 'stop' });

  expect(browser.sentOfType('ended')).toHaveLength(1);
  expect(browser.closeCode).toBe(1000);
  expect(realtime.readyState).toBe(3);
  expect(finished).toHaveBeenCalled();
});

test('starting without an OpenAI key fails closed', async () => {
  const { browser, finished } = await createConnection({ apiKey: '' });

  browser.clientFrame({ type: 'start' });

  const [error] = browser.sentOfType('error');
  expect(String(error.message)).toContain('OpenAI API key');
  expect(browser.closeCode).toBe(1011);
  expect(finished).toHaveBeenCalled();
});

test('stream tokens are single-use and carry the minted identity', async () => {
  const { mintWebchatVoiceStreamToken, consumeWebchatVoiceStreamToken } =
    await loadWebchatVoiceModule();

  const minted = mintWebchatVoiceStreamToken({
    userId: 'apiToken:abc123',
    username: 'kiosk',
  });
  expect(minted).not.toBeNull();
  expect(minted?.expiresInSeconds).toBe(60);

  expect(consumeWebchatVoiceStreamToken(minted?.token ?? '')).toEqual({
    userId: 'apiToken:abc123',
    username: 'kiosk',
  });
  expect(consumeWebchatVoiceStreamToken(minted?.token ?? '')).toBeNull();
});

test('unknown stream tokens are rejected', async () => {
  const { consumeWebchatVoiceStreamToken } = await loadWebchatVoiceModule();

  expect(consumeWebchatVoiceStreamToken('not-a-token')).toBeNull();
});

test('stream tokens expire after their TTL', async () => {
  vi.useFakeTimers();
  try {
    const { mintWebchatVoiceStreamToken, consumeWebchatVoiceStreamToken } =
      await loadWebchatVoiceModule();

    const minted = mintWebchatVoiceStreamToken({
      userId: 'user_a',
      username: null,
    });
    vi.advanceTimersByTime(61_000);
    expect(consumeWebchatVoiceStreamToken(minted?.token ?? '')).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test('pending stream tokens are capped until stale mints expire', async () => {
  vi.useFakeTimers();
  try {
    const { mintWebchatVoiceStreamToken } = await loadWebchatVoiceModule();

    for (let index = 0; index < 32; index += 1) {
      expect(
        mintWebchatVoiceStreamToken({
          userId: `user_${index}`,
          username: null,
        }),
      ).not.toBeNull();
    }
    expect(
      mintWebchatVoiceStreamToken({ userId: 'user_overflow', username: null }),
    ).toBeNull();

    vi.advanceTimersByTime(61_000);
    expect(
      mintWebchatVoiceStreamToken({ userId: 'user_fresh', username: null }),
    ).not.toBeNull();
  } finally {
    vi.useRealTimers();
  }
});
