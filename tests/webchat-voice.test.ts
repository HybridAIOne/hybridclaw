import { afterEach, expect, test, vi } from 'vitest';
import type { RealtimeSocket } from '../src/voice/openai-realtime.js';

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
    this.serverEvent({ type: 'session.updated' });
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

  async clientFrame(frame: Record<string, unknown>): Promise<void> {
    for (const listener of this.listeners.get('message') || []) {
      listener(JSON.stringify(frame));
    }
    await Promise.resolve();
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
const loadVoiceHistory = vi.fn(async () => [] as Array<{ role: 'user' | 'assistant'; text: string }>);
const consultInstructions = vi.fn((timeZone?: string) => `Clock context for ${timeZone ?? 'unknown timezone'}`);

function mockVoiceContext() {
  vi.doMock('../src/gateway/webchat-voice-context.js', () => ({
    loadWebchatVoiceHistory: loadVoiceHistory, voiceConsultInstructions: consultInstructions,
  }));
}

// The agent's name and the user's details from USER.md, as the runtime reads them.
const callContext = {
  displayNameForAgent: vi.fn((_agentId: string) => 'Hy'),
  readUserNames: vi.fn((_agentId: string) => ({
    name: 'Anna' as string | null,
    fullName: null as string | null,
  })),
  readUserTimezone: vi.fn((_agentId: string) => 'Europe/Berlin'),
  formatCurrentTime: vi.fn(
    (_timezone?: string) => 'Thursday, October 8th, 2026 — 21:30 (Europe/Berlin)',
  ),
};

function mockCallContext(): void {
  vi.doMock('../src/agents/agent-registry.js', () => ({
    displayNameForAgent: callContext.displayNameForAgent,
  }));
  vi.doMock('../src/workspace.js', () => ({
    readUserNames: callContext.readUserNames,
    readUserTimezone: callContext.readUserTimezone,
    formatCurrentTime: callContext.formatCurrentTime,
  }));
}

async function createConnection(params?: { apiKey?: string }) {
  mockVoiceContext();
  vi.doMock('../src/config/config.js', () => ({
    OPENAI_API_KEY: params?.apiKey ?? 'test-key',
    HYBRIDAI_BASE_URL: 'https://hybridai.example',
    getConfigSnapshot: () => ({ speech: { realtime: REALTIME_CONFIG } }),
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
  mockCallContext();
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
  mockVoiceContext();
  vi.doMock('../src/config/config.js', () => ({
    OPENAI_API_KEY: 'test-key',
    HYBRIDAI_BASE_URL: 'https://hybridai.example',
    getConfigSnapshot: () => ({ speech: { realtime: REALTIME_CONFIG } }),
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
  mockCallContext();
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
  loadVoiceHistory.mockReset();
  loadVoiceHistory.mockResolvedValue([]);
  consultInstructions.mockClear();
  vi.doUnmock('../src/gateway/webchat-voice-context.js');
  vi.doUnmock('../src/config/config.js');
  vi.doUnmock('../src/config/runtime-config.js');
  vi.doUnmock('../src/gateway/gateway-chat-service.js');
  vi.doUnmock('../src/gateway/voice-transcript-store.js');
  vi.doUnmock('../src/agents/agent-registry.js');
  vi.doUnmock('../src/workspace.js');
  vi.doUnmock('../src/logger.js');
  vi.resetModules();
});

test('start frame opens a PCM16 web realtime session and acks with ready', async () => {
  const { browser, realtime } = await createConnection();

  await browser.clientFrame({ type: 'start' });
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

test('a language in the start frame pins speech and transcription', async () => {
  const { browser, realtime } = await createConnection();

  await browser.clientFrame({ type: 'start', language: 'en' });
  realtime.open();

  const [sessionUpdate] = realtime.sentOfType('session.update');
  const session = sessionUpdate.session as Record<string, unknown>;
  const audio = session.audio as {
    input: { transcription: Record<string, unknown> };
  };
  expect(String(session.instructions)).toContain(
    'Speak English for the entire conversation',
  );
  expect(audio.input.transcription.language).toBe('en');
});

test('an unsupported language leaves the voice unpinned', async () => {
  const { browser, realtime } = await createConnection();

  await browser.clientFrame({ type: 'start', language: 'klingon' });
  realtime.open();

  const [sessionUpdate] = realtime.sentOfType('session.update');
  const session = sessionUpdate.session as Record<string, unknown>;
  const audio = session.audio as {
    input: { transcription: Record<string, unknown> };
  };
  expect(String(session.instructions)).not.toContain('for the entire conversation');
  expect(audio.input.transcription.language).toBeUndefined();
});

test('a valid canonical sessionId from the client is kept for consults', async () => {
  const { browser, realtime } = await createConnection();
  const sessionId = 'agent:main:channel:web:chat:dm:peer:abc123';

  await browser.clientFrame({ type: 'start', sessionId, agentId: 'main' });
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
  // Only the phone app keeps its chats from resetting.
  expect(handleGatewayMessage.mock.calls[0][0]).not.toHaveProperty('client');
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

test("a call from the phone app consults as the app's chat", async () => {
  const { browser, realtime } = await createConnection();
  const sessionId = 'main-0123456789abcdef';

  await browser.clientFrame({
    type: 'start',
    sessionId,
    agentId: 'main',
    client: 'mobile',
  });
  realtime.open();
  expect(browser.sentOfType('ready')[0].sessionId).toBe(sessionId);

  realtime.serverEvent({
    type: 'response.function_call_arguments.done',
    call_id: 'call_1',
    name: 'consult_agent',
    arguments: JSON.stringify({ request: 'What is on my calendar?' }),
  });
  await flushAsync();

  expect(handleGatewayMessage).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId, client: 'mobile' }),
  );
});

test('an unknown client is not passed on to consults', async () => {
  const { browser, realtime } = await createConnection();

  await browser.clientFrame({ type: 'start', client: 'desktop' });
  realtime.open();
  realtime.serverEvent({
    type: 'response.function_call_arguments.done',
    call_id: 'call_1',
    name: 'consult_agent',
    arguments: JSON.stringify({ request: 'What is on my calendar?' }),
  });
  await flushAsync();

  expect(handleGatewayMessage).toHaveBeenCalledTimes(1);
  expect(handleGatewayMessage.mock.calls[0][0]).not.toHaveProperty('client');
});

function sentInstructions(realtime: FakeRealtimeSocket): string {
  const [sessionUpdate] = realtime.sentOfType('session.update');
  return String((sessionUpdate.session as Record<string, unknown>).instructions);
}

test('the voice picks up knowing its name, the user and the time', async () => {
  const { browser, realtime } = await createConnection();

  await browser.clientFrame({ type: 'start', agentId: 'hy', client: 'mobile' });
  realtime.open();

  expect(callContext.displayNameForAgent).toHaveBeenCalledWith('hy');
  const instructions = sentInstructions(realtime);
  expect(instructions).toContain('You are the realtime voice of Hy,');
  expect(instructions).not.toContain('HybridClaw');
  expect(instructions).toContain('User details: name Anna.');
  expect(instructions).toContain(
    'Current date and time for the user: Thursday, October 8th, 2026 — 21:30 (Europe/Berlin).',
  );
});

test('a call goes ahead when the context cannot be read', async () => {
  callContext.readUserNames.mockImplementationOnce(() => {
    throw new Error('USER.md unreadable');
  });
  const { browser, realtime } = await createConnection();

  await browser.clientFrame({ type: 'start', agentId: 'hy' });
  realtime.open();

  expect(browser.sentOfType('ready')).toHaveLength(1);
  const instructions = sentInstructions(realtime);
  // The console login's name stands in when USER.md has none.
  expect(instructions).toContain('User details: name Ada.');
});

test.each([
  ['an unknown session id', 'agent:main:channel:web:chat:dm:peer:unknown1'],
  ['no session id', undefined],
])('starting with %s gives no preloaded messages', async (_label, sessionId) => {
  const { browser, realtime } = await createConnection();

  await browser.clientFrame({ type: 'start', sessionId });
  realtime.open();

  expect(sentInstructions(realtime)).not.toContain('earlier_chat');
  expect(realtime.sentOfType('conversation.item.create')).toEqual([]);
  expect(loadVoiceHistory).toHaveBeenCalledTimes(1);
});

test('audio flows both ways and barge-in clears browser playback', async () => {
  const { browser, realtime } = await createConnection();
  await browser.clientFrame({ type: 'start' });
  realtime.open();

  await browser.clientFrame({ type: 'audio', payload: 'dGVzdA==' });
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
  await browser.clientFrame({ type: 'start' });
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
  await browser.clientFrame({ type: 'start', sessionId, agentId: 'main' });
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
  await browser.clientFrame({ type: 'start' });
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

  await browser.clientFrame({ type: 'bogus' });

  expect(browser.sentOfType('error')).toHaveLength(1);
  expect(browser.closeCode).toBe(1008);
  expect(finished).toHaveBeenCalled();
});

test('stop ends the session and closes the upstream socket', async () => {
  const { browser, realtime, finished } = await createConnection();
  await browser.clientFrame({ type: 'start' });
  realtime.open();

  await browser.clientFrame({ type: 'stop' });

  expect(browser.sentOfType('ended')).toHaveLength(1);
  expect(browser.closeCode).toBe(1000);
  expect(realtime.readyState).toBe(3);
  expect(finished).toHaveBeenCalled();
});

test('starting without an OpenAI key fails closed', async () => {
  const { browser, finished } = await createConnection({ apiKey: '' });

  await browser.clientFrame({ type: 'start' });

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

test('the mobile call remains ringing until its chat is preloaded', async () => {
  loadVoiceHistory.mockResolvedValue([
    { role: 'assistant', text: 'The train leaves at eight.' },
  ]);
  const { browser, realtime } = await createConnection();
  await browser.clientFrame({
    type: 'start',
    sessionId: 'mobile-chat',
    agentId: 'hy',
    client: 'mobile',
    timeZone: 'Europe/Berlin',
  });
  realtime.open();
  expect(loadVoiceHistory).toHaveBeenCalledWith('mobile-chat', 'hy', 'user-1');
  expect(browser.sentOfType('ready')).toEqual([]);
  expect(realtime.sentOfType('response.create')).toEqual([]);
  const item = realtime.sentOfType('conversation.item.create')[0].item;
  realtime.serverEvent({ type: 'conversation.item.done', item });
  expect(browser.sentOfType('ready')).toEqual([
    { type: 'ready', sessionId: 'mobile-chat' },
  ]);
  expect(realtime.sentOfType('response.create')).toHaveLength(1);
  realtime.serverEvent({
    type: 'response.function_call_arguments.done',
    call_id: 'time',
    name: 'consult_agent',
    arguments: '{"request":"What time is it?"}',
  });
  await flushAsync();
  expect(consultInstructions).toHaveBeenCalledWith('Europe/Berlin');
  expect(handleGatewayMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      instructions: 'Clock context for Europe/Berlin',
      content: 'What time is it?',
    }),
  );
  browser.close();
});

test('a history loading failure cannot open a context-free call', async () => {
  loadVoiceHistory.mockImplementation(() => {
    throw new Error('not owned');
  });
  const { browser, realtime } = await createConnection();
  await browser.clientFrame({ type: 'start', sessionId: 'someone-elses-chat' });
  expect(browser.closeCode).toBe(1011);
  expect(browser.sentOfType('ready')).toEqual([]);
  expect(realtime.sent).toEqual([]);
});

test('a call whose history never finalizes times out while ringing', async () => {
  vi.useFakeTimers();
  try {
    loadVoiceHistory.mockResolvedValue([
      { role: 'user', text: 'Earlier turn' },
    ]);
    const { browser, realtime } = await createConnection();
    await browser.clientFrame({ type: 'start' });
    realtime.open();
    await vi.advanceTimersByTimeAsync(20_001);
    expect(browser.closeCode).toBe(1011);
    expect(browser.sentOfType('ready')).toEqual([]);
    expect(realtime.readyState).toBe(3);
  } finally {
    vi.useRealTimers();
  }
});

test.each([42, null, [], 'Invalid/Zone', 'x'.repeat(101)])(
  'rejects invalid voice start timezone %j',
  async (timeZone) => {
    const { browser, realtime } = await createConnection();
    await browser.clientFrame({ type: 'start', timeZone });
    expect(browser.closeCode).toBe(1008);
    expect(realtime.sent).toEqual([]);
    expect(browser.sentOfType('error')[0]?.message).toBe(
      'Invalid voice timezone.',
    );
  },
);

test('hanging up during auxiliary summarization cannot open a late upstream call', async () => {
  let finish!: (history: Awaited<ReturnType<typeof loadVoiceHistory>>) => void;
  loadVoiceHistory.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const { browser, realtime } = await createConnection();
  try {
    await browser.clientFrame({ type: 'start' });
    expect(browser.sentOfType('ready')).toEqual([]);
    expect(realtime.url).toBe('');
    browser.close();
    finish([{ role: 'user', text: 'Previous conversation summary' }]);
    await flushAsync();
    expect(realtime.url).toBe('');
    expect(realtime.sent).toEqual([]);
  } finally {
    finish([]);
    browser.close();
  }
});

test('a second start cannot launch another summary while the first is pending', async () => {
  let finish!: (history: Awaited<ReturnType<typeof loadVoiceHistory>>) => void;
  loadVoiceHistory.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const { browser, realtime } = await createConnection();
  try {
    await browser.clientFrame({ type: 'start' });
    await browser.clientFrame({ type: 'start' });
    expect(loadVoiceHistory).toHaveBeenCalledTimes(1);
    expect(browser.closeCode).toBe(1008);
    finish([]);
    await flushAsync();
    expect(realtime.url).toBe('');
  } finally {
    finish([]);
    browser.close();
  }
});
