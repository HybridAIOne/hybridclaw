import { expect, test, vi } from 'vitest';
import type { RealtimeSocket } from '../src/channels/voice/openai-realtime.js';
import {
  buildRealtimeInstructions,
  RealtimeCallBridge,
  type RealtimeBridgeOptions,
  type RealtimeBridgeState,
} from '../src/channels/voice/realtime-bridge.js';

const REALTIME_CONFIG = {
  provider: 'openai' as const,
  model: 'gpt-realtime',
  voice: 'marin',
  greeting: 'Hi there!',
  instructions: 'Prefer metric units.',
};

const CALLER = {
  from: '+15550001111',
  to: '+15550002222',
  callerName: 'Ada Example',
};

class FakeRealtimeSocket implements RealtimeSocket {
  readyState = 1;
  url = '';
  headers: Record<string, string> = {};
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
    this.emit('close');
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) || []) {
      listener(...args);
    }
  }

  open(): void {
    this.emit('open');
  }

  serverEvent(event: Record<string, unknown>): void {
    this.emit('message', JSON.stringify(event));
  }

  sentOfType(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((event) => event.type === type);
  }
}

function createBridge(overrides?: Partial<RealtimeBridgeOptions>): {
  bridge: RealtimeCallBridge;
  socket: FakeRealtimeSocket;
  sentAudio: string[];
  clears: number[];
  states: RealtimeBridgeState[];
  transcripts: Array<{ role: string; text: string }>;
  errors: string[];
  consultAgent: ReturnType<typeof vi.fn>;
} {
  const socket = new FakeRealtimeSocket();
  const sentAudio: string[] = [];
  const clears: number[] = [];
  const states: RealtimeBridgeState[] = [];
  const transcripts: Array<{ role: string; text: string }> = [];
  const errors: string[] = [];
  const consultAgent = vi.fn(async () => 'You have two meetings today.');
  const bridge = new RealtimeCallBridge({
    connection: {
      url: 'wss://api.openai.com/v1/realtime',
      apiKey: 'test-key',
    },
    config: REALTIME_CONFIG,
    caller: CALLER,
    surface: 'phone',
    audioFormat: { type: 'audio/pcmu' },
    sendAudio: async (base64Audio) => {
      sentAudio.push(base64Audio);
    },
    clearPlayback: async () => {
      clears.push(1);
    },
    consultAgent,
    onTranscript: (role, text) => {
      transcripts.push({ role, text });
    },
    onStateChange: (state) => {
      states.push(state);
    },
    onError: (message) => {
      errors.push(message);
    },
    onClosed: () => {},
    socketFactory: (url, headers) => {
      socket.url = url;
      socket.headers = headers;
      return socket;
    },
    ...overrides,
  });
  return {
    bridge,
    socket,
    sentAudio,
    clears,
    states,
    transcripts,
    errors,
    consultAgent,
  };
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test('buildRealtimeInstructions layers persona, caller details, and extras', () => {
  const instructions = buildRealtimeInstructions(REALTIME_CONFIG, CALLER);

  expect(instructions).toContain('realtime voice of HybridClaw');
  expect(instructions).toContain('consult_agent');
  expect(instructions).toContain('name Ada Example');
  expect(instructions).toContain('calling from +15550001111');
  expect(instructions).toContain('Prefer metric units.');
});

test('web surface swaps the phone framing and PCM16 audio format', () => {
  const instructions = buildRealtimeInstructions(REALTIME_CONFIG, CALLER, 'web');
  expect(instructions).toContain('web console');
  expect(instructions).not.toContain('phone call');
  expect(instructions).toContain('User details');

  const { socket } = createBridge({
    surface: 'web',
    audioFormat: { type: 'audio/pcm', rate: 24000 },
  });
  socket.open();
  const [sessionUpdate] = socket.sentOfType('session.update');
  const session = sessionUpdate.session as Record<string, unknown>;
  const audio = session.audio as {
    input: { format: { type: string; rate?: number } };
    output: { format: { type: string; rate?: number } };
  };
  expect(audio.input.format).toEqual({ type: 'audio/pcm', rate: 24000 });
  expect(audio.output.format).toEqual({ type: 'audio/pcm', rate: 24000 });
});

test('bridge configures a µ-law realtime session and speaks the greeting', () => {
  const { socket } = createBridge();
  socket.open();

  expect(socket.url).toContain('model=gpt-realtime');
  expect(socket.headers.Authorization).toBe('Bearer test-key');
  const [sessionUpdate] = socket.sentOfType('session.update');
  const session = sessionUpdate.session as Record<string, unknown>;
  const audio = session.audio as {
    input: { format: { type: string } };
    output: { format: { type: string }; voice: string };
  };
  expect(audio.input.format.type).toBe('audio/pcmu');
  expect(audio.output.format.type).toBe('audio/pcmu');
  expect(audio.output.voice).toBe('marin');
  const tools = session.tools as Array<{ name: string }>;
  expect(tools.map((tool) => tool.name)).toEqual(['consult_agent']);

  socket.serverEvent({ type: 'session.updated' });
  const [greeting] = socket.sentOfType('response.create');
  expect(greeting.response).toEqual({
    instructions: 'Greet the caller by saying: "Hi there!"',
  });
});

test('bridge forwards caller audio upstream and model audio downstream', () => {
  const { bridge, socket, sentAudio, states } = createBridge();
  socket.open();

  bridge.handleCallerAudio('dGVzdA==');
  expect(socket.sentOfType('input_audio_buffer.append')).toEqual([
    { type: 'input_audio_buffer.append', audio: 'dGVzdA==' },
  ]);

  socket.serverEvent({ type: 'response.created' });
  socket.serverEvent({ type: 'response.output_audio.delta', delta: 'bXU=' });
  expect(sentAudio).toEqual(['bXU=']);
  expect(states).toContain('speaking');
});

test('caller audio from before the socket opens is flushed after setup', () => {
  const { bridge, socket } = createBridge();
  socket.readyState = 0;

  bridge.handleCallerAudio('ZWFybHk=');
  expect(socket.sentOfType('input_audio_buffer.append')).toHaveLength(0);

  socket.readyState = 1;
  socket.open();

  const types = socket.sent.map((event) => event.type);
  expect(types.indexOf('session.update')).toBeLessThan(
    types.indexOf('input_audio_buffer.append'),
  );
  expect(socket.sentOfType('input_audio_buffer.append')).toEqual([
    { type: 'input_audio_buffer.append', audio: 'ZWFybHk=' },
  ]);
});

test('caller speech clears queued playback and cancels the active response', () => {
  const { socket, clears, states } = createBridge();
  socket.open();
  socket.serverEvent({ type: 'response.created' });

  socket.serverEvent({ type: 'input_audio_buffer.speech_started' });

  expect(states).toContain('listening');
  expect(socket.sentOfType('response.cancel')).toHaveLength(1);
  expect(clears).toHaveLength(1);

  // A second speech start without an active response must not double-cancel.
  socket.serverEvent({ type: 'input_audio_buffer.speech_started' });
  expect(socket.sentOfType('response.cancel')).toHaveLength(1);
});

test('consult_agent tool calls run the gateway turn and return its reply', async () => {
  const { socket, states, consultAgent } = createBridge();
  socket.open();

  socket.serverEvent({
    type: 'response.function_call_arguments.done',
    call_id: 'call_1',
    name: 'consult_agent',
    arguments: JSON.stringify({ request: 'What is on my calendar?' }),
  });
  await flushAsync();

  expect(consultAgent).toHaveBeenCalledWith(
    'What is on my calendar?',
    expect.objectContaining({
      abortSignal: expect.any(AbortSignal),
      onToolProgress: expect.any(Function),
    }),
  );
  expect(states).toContain('thinking');
  const outputs = socket
    .sentOfType('conversation.item.create')
    .map((event) => event.item as Record<string, unknown>);
  expect(outputs).toContainEqual({
    type: 'function_call_output',
    call_id: 'call_1',
    output: 'You have two meetings today.',
  });
  expect(socket.sentOfType('response.create').length).toBeGreaterThan(0);
});

test('concurrent consults are rejected while one is in flight', async () => {
  let resolveConsult: (reply: string) => void = () => {};
  const consultAgent = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        resolveConsult = resolve;
      }),
  );
  const { socket } = createBridge({ consultAgent });
  socket.open();

  socket.serverEvent({
    type: 'response.function_call_arguments.done',
    call_id: 'call_1',
    name: 'consult_agent',
    arguments: JSON.stringify({ request: 'First request' }),
  });
  socket.serverEvent({
    type: 'response.function_call_arguments.done',
    call_id: 'call_2',
    name: 'consult_agent',
    arguments: JSON.stringify({ request: 'Second request' }),
  });
  await flushAsync();

  expect(consultAgent).toHaveBeenCalledTimes(1);
  const busyOutput = socket
    .sentOfType('conversation.item.create')
    .map((event) => event.item as Record<string, unknown>)
    .find((item) => item.call_id === 'call_2');
  expect(String(busyOutput?.output)).toContain('still working');

  resolveConsult('Done.');
  await flushAsync();
  const firstOutput = socket
    .sentOfType('conversation.item.create')
    .map((event) => event.item as Record<string, unknown>)
    .find((item) => item.call_id === 'call_1');
  expect(firstOutput?.output).toBe('Done.');
});

test('consult failures surface an apologetic tool output, not silence', async () => {
  const consultAgent = vi.fn(async () => {
    throw new Error('container crashed');
  });
  const { socket, errors } = createBridge({ consultAgent });
  socket.open();

  socket.serverEvent({
    type: 'response.function_call_arguments.done',
    call_id: 'call_1',
    name: 'consult_agent',
    arguments: JSON.stringify({ request: 'Do the thing' }),
  });
  await flushAsync();

  expect(errors.some((entry) => entry.includes('container crashed'))).toBe(
    true,
  );
  const output = socket
    .sentOfType('conversation.item.create')
    .map((event) => event.item as Record<string, unknown>)
    .find((item) => item.call_id === 'call_1');
  expect(String(output?.output)).toContain('hit an error');
});

test('malformed tool arguments produce a rephrase prompt', async () => {
  const { socket, consultAgent } = createBridge();
  socket.open();

  socket.serverEvent({
    type: 'response.function_call_arguments.done',
    call_id: 'call_1',
    name: 'consult_agent',
    arguments: 'not-json',
  });
  await flushAsync();

  expect(consultAgent).not.toHaveBeenCalled();
  const output = socket
    .sentOfType('conversation.item.create')
    .map((event) => event.item as Record<string, unknown>)
    .find((item) => item.call_id === 'call_1');
  expect(String(output?.output)).toContain('rephrase');
});

test('late response.cancel rejections stay silent; real errors surface', () => {
  const { socket, errors } = createBridge();
  socket.open();

  socket.serverEvent({
    type: 'error',
    error: {
      type: 'invalid_request_error',
      code: 'response_cancel_not_active',
      message: 'Cancellation failed: no active response found',
    },
  });
  expect(errors).toHaveLength(0);

  socket.serverEvent({
    type: 'error',
    error: { type: 'server_error', message: 'boom' },
  });
  expect(errors).toEqual(['boom']);
});

test('DTMF digits are injected as caller text', () => {
  const { bridge, socket } = createBridge();
  socket.open();

  bridge.handleDtmf('5');

  const items = socket
    .sentOfType('conversation.item.create')
    .map((event) => event.item as Record<string, unknown>);
  expect(items).toHaveLength(1);
  const content = items[0].content as Array<{ type: string; text: string }>;
  expect(content[0].text).toContain('"5"');
});

test('long consults speak out-of-band reassurance with live tool activity', async () => {
  vi.useFakeTimers();
  try {
    let resolveConsult: (reply: string) => void = () => {};
    let toolProgress: (event: {
      toolName: string;
      phase: 'start' | 'finish';
    }) => void = () => {};
    const consultAgent = vi.fn(
      (_request: string, hooks: { onToolProgress: typeof toolProgress }) => {
        toolProgress = hooks.onToolProgress;
        return new Promise<string>((resolve) => {
          resolveConsult = resolve;
        });
      },
    );
    const consultActivity: Array<string | null> = [];
    const { socket } = createBridge({
      consultAgent,
      onConsultActivity: (label) => {
        consultActivity.push(label);
      },
    });
    socket.open();
    socket.serverEvent({
      type: 'response.function_call_arguments.done',
      call_id: 'call_1',
      name: 'consult_agent',
      arguments: JSON.stringify({ request: 'Audit my inbox' }),
    });
    await Promise.resolve();

    toolProgress({ toolName: 'web_search', phase: 'start' });
    expect(consultActivity).toEqual(['web search']);

    await vi.advanceTimersByTimeAsync(7_000);
    const [first] = socket.sentOfType('response.create');
    expect(first.response).toEqual({
      conversation: 'none',
      instructions: expect.stringContaining('web search'),
    });

    // Repeats stay out-of-band on the follow-up cadence.
    await vi.advanceTimersByTimeAsync(12_000);
    expect(socket.sentOfType('response.create')).toHaveLength(2);

    resolveConsult('Inbox is clean.');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(consultActivity).toEqual(['web search', null]);

    // No further reassurance once the consult resolved.
    await vi.advanceTimersByTimeAsync(30_000);
    const reassurances = socket
      .sentOfType('response.create')
      .filter(
        (event) =>
          (event.response as { conversation?: string } | undefined)
            ?.conversation === 'none',
      );
    expect(reassurances).toHaveLength(2);
  } finally {
    vi.useRealTimers();
  }
});

test('reassurance prompt names only real tool activity and forbids invented status', async () => {
  vi.useFakeTimers();
  try {
    let toolProgress: (event: {
      toolName: string;
      phase: 'start' | 'finish';
    }) => void = () => {};
    const consultAgent = vi.fn(
      (_request: string, hooks: { onToolProgress: typeof toolProgress }) => {
        toolProgress = hooks.onToolProgress;
        return new Promise<string>(() => {});
      },
    );
    const { socket } = createBridge({ consultAgent, surface: 'web' });
    socket.open();
    socket.serverEvent({
      type: 'response.function_call_arguments.done',
      call_id: 'call_1',
      name: 'consult_agent',
      arguments: JSON.stringify({ request: 'Show the latest invoice' }),
    });
    await Promise.resolve();

    // Before any tool has started, the prompt forbids guessing at activity.
    await vi.advanceTimersByTimeAsync(7_000);
    const [first] = socket.sentOfType('response.create');
    const firstText = String(
      (first.response as { instructions?: string }).instructions,
    );
    expect(firstText).toContain('Do not guess what it is doing.');
    expect(firstText).toContain(
      'do not claim to need access, credentials, or more details',
    );
    expect(firstText).toContain('do not ask the user anything');

    // Once a tool starts, the prompt pins the message to that activity.
    toolProgress({ toolName: 'http_request', phase: 'start' });
    await vi.advanceTimersByTimeAsync(12_000);
    const second = socket.sentOfType('response.create')[1];
    const secondText = String(
      (second.response as { instructions?: string }).instructions,
    );
    expect(secondText).toContain('"http request"');
    expect(secondText).not.toContain('Do not guess what it is doing.');
  } finally {
    vi.useRealTimers();
  }
});

test('reassurance stays silent while the caller speaks or the model talks', async () => {
  vi.useFakeTimers();
  try {
    const consultAgent = vi.fn(() => new Promise<string>(() => {}));
    const { socket } = createBridge({ consultAgent });
    socket.open();
    socket.serverEvent({
      type: 'response.function_call_arguments.done',
      call_id: 'call_1',
      name: 'consult_agent',
      arguments: JSON.stringify({ request: 'Slow request' }),
    });
    await Promise.resolve();

    // Caller starts speaking before the first reassurance fires.
    socket.serverEvent({ type: 'input_audio_buffer.speech_started' });
    await vi.advanceTimersByTimeAsync(7_000);
    expect(socket.sentOfType('response.create')).toHaveLength(0);

    // Their utterance is transcribed; the next tick may speak again.
    socket.serverEvent({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'Take your time.',
    });
    await vi.advanceTimersByTimeAsync(12_000);
    expect(socket.sentOfType('response.create')).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

test('transcripts are surfaced per role and close aborts consults', () => {
  const { bridge, socket, transcripts } = createBridge();
  socket.open();

  socket.serverEvent({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: 'What time is it?',
  });
  socket.serverEvent({
    type: 'response.output_audio_transcript.done',
    transcript: 'It is noon.',
  });

  expect(transcripts).toEqual([
    { role: 'caller', text: 'What time is it?' },
    { role: 'assistant', text: 'It is noon.' },
  ]);

  bridge.close();
  expect(bridge.isOpen).toBe(false);
});
