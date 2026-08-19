import { afterEach, expect, test, vi } from 'vitest';
import {
  muLawToPcm16,
  pcm16ToMuLaw,
} from '../src/channels/voice/audio-codec.js';
import type { RealtimeSocket } from '../src/channels/voice/openai-realtime.js';

const REALTIME_CONFIG = {
  provider: 'openai' as const,
  model: 'gpt-realtime',
  voice: 'marin',
  greeting: 'Hello from config!',
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

const dispatch = vi.fn(async () => ({
  status: 'success' as const,
  result: 'All **done**.',
  toolsUsed: [],
}));

const persistVoiceTranscript = vi.fn();

const SESSION_IDENTITY = {
  sessionId: 'agent:main:channel:voice:chat:dm:peer:call-1',
  channelId: 'voice:call-1',
  userId: '+15550001111',
  username: '+15550001111',
};

async function createSession(params?: {
  apiKey?: string;
  sentFrames?: Buffer[];
}) {
  vi.doMock('../src/config/config.js', () => ({
    OPENAI_API_KEY: params?.apiKey ?? 'test-key',
    HYBRIDAI_BASE_URL: 'https://hybridai.example',
    getConfigSnapshot: () => ({ voice: { realtime: REALTIME_CONFIG } }),
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
  const { createPluginRealtimeVoiceSession } = await import(
    '../src/plugins/plugin-realtime-voice.js'
  );
  const realtime = new FakeRealtimeSocket();
  const sentFrames = params?.sentFrames ?? [];
  const session = createPluginRealtimeVoiceSession(
    {
      caller: { from: '+15550001111', to: '+15550002222' },
      greeting: 'Hi from the plugin!',
      session: SESSION_IDENTITY,
      sendAudio: (frame) => {
        sentFrames.push(frame);
      },
    },
    {
      pluginId: 'vonage-voice',
      agentId: 'main',
      dispatch,
      socketFactory: (url) => {
        realtime.url = url;
        return realtime;
      },
    },
  );
  return { session, realtime, sentFrames };
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  dispatch.mockClear();
  persistVoiceTranscript.mockClear();
  vi.doUnmock('../src/config/config.js');
  vi.doUnmock('../src/gateway/voice-transcript-store.js');
  vi.doUnmock('../src/logger.js');
  vi.resetModules();
  vi.useRealTimers();
});

test('opens a µ-law phone session with the plugin greeting', async () => {
  const { session, realtime } = await createSession();
  realtime.open();

  const [sessionUpdate] = realtime.sentOfType('session.update');
  const sessionPayload = sessionUpdate.session as Record<string, unknown>;
  const audio = sessionPayload.audio as {
    input: { format: { type: string } };
    output: { format: { type: string } };
  };
  expect(audio.input.format.type).toBe('audio/pcmu');
  expect(audio.output.format.type).toBe('audio/pcmu');

  realtime.serverEvent({ type: 'session.updated' });
  const [greeting] = realtime.sentOfType('response.create');
  expect(greeting.response).toEqual({
    instructions: 'Greet the caller by saying: "Hi from the plugin!"',
  });
  session.close();
});

test('caller PCM frames go upstream as µ-law', async () => {
  const { session, realtime } = await createSession();
  realtime.open();

  const pcm = Buffer.alloc(320);
  pcm.writeInt16LE(1_000, 0);
  pcm.writeInt16LE(-1_000, 2);
  session.handleCallerAudio(pcm);

  const [append] = realtime.sentOfType('input_audio_buffer.append');
  expect(append.audio).toBe(pcm16ToMuLaw(pcm).toString('base64'));
  session.close();
});

test('creating a session without a realtime credential fails closed', async () => {
  await expect(createSession({ apiKey: '' })).rejects.toThrow(
    /OpenAI API key/,
  );
});

test('model audio is paced into 20ms PCM frames and cleared on barge-in', async () => {
  vi.useFakeTimers();
  const { session, realtime, sentFrames } = await createSession();
  realtime.open();

  // Two frames' worth of silence (320 µ-law bytes → 640 PCM bytes).
  const mulaw = Buffer.alloc(320, 0xff);
  realtime.serverEvent({
    type: 'response.output_audio.delta',
    delta: mulaw.toString('base64'),
  });
  await vi.advanceTimersByTimeAsync(20);
  expect(sentFrames).toHaveLength(1);
  expect(sentFrames[0].length).toBe(320);
  expect(sentFrames[0].equals(muLawToPcm16(mulaw).subarray(0, 320))).toBe(
    true,
  );

  await vi.advanceTimersByTimeAsync(20);
  expect(sentFrames).toHaveLength(2);

  // Queue more audio, then barge in before it plays: nothing further sends.
  realtime.serverEvent({
    type: 'response.output_audio.delta',
    delta: mulaw.toString('base64'),
  });
  realtime.serverEvent({ type: 'input_audio_buffer.speech_started' });
  await vi.advanceTimersByTimeAsync(200);
  expect(sentFrames).toHaveLength(2);
  session.close();
});

test('a sub-frame audio tail is zero-padded out instead of sticking', async () => {
  vi.useFakeTimers();
  const { session, realtime, sentFrames } = await createSession();
  realtime.open();

  const mulaw = Buffer.alloc(100, 0xff); // 200 PCM bytes < one 320-byte frame
  realtime.serverEvent({
    type: 'response.output_audio.delta',
    delta: mulaw.toString('base64'),
  });
  await vi.advanceTimersByTimeAsync(40);
  expect(sentFrames).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(40);
  expect(sentFrames).toHaveLength(1);
  expect(sentFrames[0].length).toBe(320);
  session.close();
});

test('consults dispatch through the plugin seam and persist transcripts', async () => {
  const { session, realtime } = await createSession();
  realtime.open();

  realtime.serverEvent({
    type: 'response.function_call_arguments.done',
    call_id: 'call_1',
    name: 'consult_agent',
    arguments: JSON.stringify({ request: 'Summarize my day' }),
  });
  await flushAsync();

  expect(dispatch).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: SESSION_IDENTITY.sessionId,
      sessionMode: 'resume',
      channelId: 'voice:call-1',
      userId: '+15550001111',
      content: 'Summarize my day',
      agentId: 'main',
      abortSignal: expect.any(AbortSignal),
      onToolProgress: expect.any(Function),
    }),
  );
  const outputs = realtime
    .sentOfType('conversation.item.create')
    .map((event) => event.item as Record<string, unknown>);
  // Voice-formatted: markdown stripped before speech.
  expect(outputs).toContainEqual(
    expect.objectContaining({ call_id: 'call_1', output: 'All done.' }),
  );

  realtime.serverEvent({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: 'What time is it?',
  });
  expect(persistVoiceTranscript).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: SESSION_IDENTITY.sessionId,
      agentId: 'main',
      role: 'user',
      text: 'What time is it?',
    }),
  );
  session.close();
});

test('close stops the pacer and the upstream socket', async () => {
  vi.useFakeTimers();
  const { session, realtime, sentFrames } = await createSession();
  realtime.open();

  realtime.serverEvent({
    type: 'response.output_audio.delta',
    delta: Buffer.alloc(320, 0xff).toString('base64'),
  });
  session.close();
  await vi.advanceTimersByTimeAsync(200);

  expect(sentFrames).toHaveLength(0);
  expect(session.isOpen).toBe(false);
  expect(realtime.readyState).toBe(3);
});
