import { Readable } from 'node:stream';
import { expect, test, vi } from 'vitest';
import plugin from '../plugins/twilio-voice/src/index.js';
import { buildTwilioSignature } from '../plugins/twilio-voice/src/security.js';
import type {
  HybridClawPluginApi,
  PluginCommandDefinition,
  PluginInboundWebhookDefinition,
  PluginService,
  PluginWebsocketWebhookDefinition,
} from '../src/plugins/plugin-sdk.js';
import { formatTextForVoice } from '../src/voice/text.js';
import { useCleanMocks } from './test-utils.js';

useCleanMocks({ restoreAllMocks: true, unstubAllGlobals: true });

const AUTH_TOKEN = 'test-key';
const PUBLIC_BASE = 'https://voice.example.com';
const WEBHOOK_PATH = '/api/plugin-webhooks/twilio-voice/webhook';
const ACTION_PATH = '/api/plugin-webhooks/twilio-voice/action';
const RELAY_PATH = '/api/plugin-webhooks/twilio-voice/relay';
const STREAM_PATH = '/api/plugin-webhooks/twilio-voice/stream';
const CALL = { CallSid: 'CA123', From: '+15550001111', To: '+15550002222' };

function voiceConfig() {
  return {
    enabled: true,
    provider: 'twilio',
    mode: 'relay' as 'relay' | 'realtime',
    twilio: { accountSid: 'AC123', authToken: '', fromNumber: '+14155550123' },
    relay: {
      ttsProvider: 'default',
      voice: '',
      transcriptionProvider: 'default',
      language: 'en-US',
      interruptible: true,
      welcomeGreeting: 'Hello! How can I help you today?',
    },
    prompt: { greeting: '', instructions: '' },
    callerPolicy: 'open' as 'open' | 'allowlist' | 'disabled',
    allowFrom: [] as string[],
    maxConcurrentCalls: 8,
  };
}

class FakeSocket {
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) || []), listener]);
  }

  send(data: string, cb?: (error?: Error) => void): void {
    this.sent.push(JSON.parse(data));
    cb?.();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    for (const listener of this.listeners.get('close') || []) {
      listener(1000, Buffer.alloc(0));
    }
  }

  receive(payload: Record<string, unknown>): void {
    for (const listener of this.listeners.get('message') || []) {
      listener(Buffer.from(JSON.stringify(payload)), false);
    }
  }
}

function createHarness(
  options: {
    publicBaseUrl?: string | null;
    authToken?: string;
    dispatch?: HybridClawPluginApi['dispatchInboundMessage'];
  } = {},
) {
  const voice = voiceConfig();
  const webhooks = new Map<string, PluginInboundWebhookDefinition>();
  const websockets = new Map<string, PluginWebsocketWebhookDefinition>();
  const commands: PluginCommandDefinition[] = [];
  const services: PluginService[] = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const realtimeSession = {
    handleCallerAudio: vi.fn(),
    handleDtmf: vi.fn(),
    close: vi.fn(),
    isOpen: true,
  };
  const agents = { defaultAgentId: 'main' };
  const api = {
    getDefaultAgentId: () => agents.defaultAgentId,
    getVoiceConfig: () => voice,
    getPublicBaseUrl: () =>
      options.publicBaseUrl === undefined ? PUBLIC_BASE : options.publicBaseUrl,
    getCredential: (key: string) =>
      key === 'TWILIO_AUTH_TOKEN'
        ? (options.authToken ?? AUTH_TOKEN) || undefined
        : undefined,
    formatTextForSpeech: formatTextForVoice,
    isRealtimeVoiceAvailable: () => true,
    createRealtimeVoiceSession: vi.fn(() => realtimeSession),
    dispatchInboundMessage: vi.fn(
      options.dispatch ||
        (async () => ({ status: 'success', result: 'Done.' }) as never),
    ),
    registerInboundWebhook: (webhook: PluginInboundWebhookDefinition) =>
      webhooks.set(webhook.name, webhook),
    registerWebsocketWebhook: (webhook: PluginWebsocketWebhookDefinition) =>
      websockets.set(webhook.name, webhook),
    registerCommand: (command: PluginCommandDefinition) =>
      commands.push(command),
    registerService: (service: PluginService) => services.push(service),
    logger,
  };
  plugin.register(api as unknown as HybridClawPluginApi);

  async function post(
    name: 'webhook' | 'action',
    body: Record<string, string>,
    headers: Record<string, string> = {},
  ) {
    const path = name === 'webhook' ? WEBHOOK_PATH : ACTION_PATH;
    const res = {
      body: '',
      statusCode: 0,
      headersSent: false,
      writableEnded: false,
      setHeader: vi.fn(),
      end(chunk?: string) {
        this.body += chunk || '';
        this.headersSent = true;
        this.writableEnded = true;
      },
    };
    const req = Object.assign(
      Readable.from([Buffer.from(new URLSearchParams(body).toString())]),
      {
        headers: {
          host: 'voice.example.com',
          'x-twilio-signature': buildTwilioSignature({
            authToken: AUTH_TOKEN,
            url: `${PUBLIC_BASE}${path}`,
            values: body,
          }),
          ...headers,
        },
        socket: { remoteAddress: '127.0.0.1' },
      },
    );
    await webhooks.get(name)?.handler({
      req,
      res,
      url: new URL(`http://voice.example.com${path}`),
      webhookName: name,
      logger,
    } as never);
    return res;
  }

  async function upgrade(name: 'relay' | 'stream', signature?: string) {
    const path = name === 'relay' ? RELAY_PATH : STREAM_PATH;
    const socket = new FakeSocket();
    const rejections: Array<[number, string]> = [];
    await websockets.get(name)?.handler({
      req: {
        headers: {
          host: 'voice.example.com',
          'x-twilio-signature':
            signature ??
            buildTwilioSignature({
              authToken: AUTH_TOKEN,
              url: `wss://voice.example.com${path}`,
            }),
        },
        socket: { remoteAddress: '127.0.0.1' },
      },
      url: new URL(`http://voice.example.com${path}`),
      webhookName: name,
      logger,
      accept: async () => socket,
      reject: (status: number, message: string) =>
        rejections.push([status, message]),
    } as never);
    return { socket, rejections };
  }

  return {
    api,
    agents,
    voice,
    logger,
    commands,
    services,
    webhooks,
    websockets,
    realtimeSession,
    post,
    upgrade,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
}

test('registers the Twilio webhooks, sockets, runtime service, and a local-only voice command', async () => {
  const harness = createHarness();

  expect([...harness.webhooks.keys()]).toEqual(['webhook', 'action']);
  expect([...harness.webhooks.values()].map((hook) => hook.method)).toEqual([
    'POST',
    'POST',
  ]);
  expect([...harness.websockets.keys()]).toEqual(['relay', 'stream']);
  expect(harness.services.map((service) => service.id)).toEqual([
    'twilio-voice-runtime',
  ]);
  expect(harness.commands).toEqual([
    expect.objectContaining({
      name: 'voice',
      adminAction: 'admin.channels.write',
    }),
  ]);
  await expect(
    harness.commands[0].handler(['info'], {} as never),
  ).resolves.toContain(`Webhook: ${PUBLIC_BASE}${WEBHOOK_PATH}`);
  await expect(
    harness.commands[0].handler(['dial'], {} as never),
  ).rejects.toThrow('Usage: `voice [info|call <e164-number>]`');
});

test('an incoming call gets ConversationRelay TwiML pointing at the plugin socket', async () => {
  const harness = createHarness();

  const res = await harness.post('webhook', CALL);

  expect(res.statusCode).toBe(200);
  expect(res.body).toContain(`<Connect action="${PUBLIC_BASE}${ACTION_PATH}">`);
  expect(res.body).toContain(
    `<ConversationRelay url="wss://voice.example.com${RELAY_PATH}"`,
  );
  expect(res.body).toContain('<Parameter name="callReference" value="CA123" />');
});

test.each([
  { source: 'the gateway public URL', publicBaseUrl: PUBLIC_BASE, headers: {} },
  {
    source: 'forwarded tunnel headers',
    publicBaseUrl: null,
    headers: {
      host: '127.0.0.1:9090',
      'x-forwarded-host': 'voice.example.com',
      'x-forwarded-proto': 'https',
    },
  },
])('realtime mode answers with a media stream on $source', async ({
  publicBaseUrl,
  headers,
}) => {
  const harness = createHarness({ publicBaseUrl });
  harness.voice.mode = 'realtime';

  const res = await harness.post('webhook', CALL, headers);

  expect(res.statusCode).toBe(200);
  expect(res.body).toContain(`<Stream url="wss://voice.example.com${STREAM_PATH}">`);
  expect(res.body).not.toContain('<ConversationRelay');
});

test.each([
  {
    case: 'a forged signature',
    headers: { 'x-twilio-signature': 'forged' },
    status: 403,
    body: '<Response></Response>',
  },
  {
    case: 'a signature for another URL',
    headers: {
      'x-twilio-signature': buildTwilioSignature({
        authToken: AUTH_TOKEN,
        url: `${PUBLIC_BASE}/voice/webhook`,
        values: CALL,
      }),
    },
    status: 403,
    body: '<Response></Response>',
  },
])('rejects $case before touching call state', async ({ headers, status, body }) => {
  const harness = createHarness();

  const res = await harness.post('webhook', CALL, headers);

  expect(res.statusCode).toBe(status);
  expect(res.body).toContain(body);
  expect(harness.logger.warn).toHaveBeenCalledWith(
    expect.objectContaining({ webhook: 'webhook', hasSignature: true }),
    'Twilio webhook rejected: invalid signature',
  );
});

test.each(['webhook', 'action'] as const)(
  'refuses a replayed %s request inside the replay window',
  async (name) => {
    const harness = createHarness();
    const headers = { 'i-twilio-idempotency-token': 'idem-1' };

    const first = await harness.post(name, CALL, headers);
    const replay = await harness.post(name, CALL, headers);

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(409);
    expect(replay.body).toContain('Duplicate Twilio voice request ignored.');
  },
);

test.each([
  {
    case: 'voice is disabled',
    edit: (voice: ReturnType<typeof voiceConfig>) => {
      voice.enabled = false;
    },
    spoken: 'HybridClaw voice is unavailable right now.',
  },
  {
    case: 'the caller is not on the allowlist',
    edit: (voice: ReturnType<typeof voiceConfig>) => {
      voice.callerPolicy = 'allowlist';
      voice.allowFrom = ['+4915123456789'];
    },
    spoken: 'Sorry, this number is not available for your call.',
  },
  {
    case: 'every call slot is taken',
    edit: (voice: ReturnType<typeof voiceConfig>) => {
      voice.maxConcurrentCalls = 0;
    },
    spoken: 'HybridClaw voice is at capacity right now.',
  },
])('hangs up with a spoken notice when $case, read live per call', async ({
  edit,
  spoken,
}) => {
  const harness = createHarness();
  edit(harness.voice);

  const res = await harness.post('webhook', CALL);

  expect(res.statusCode).toBe(200);
  expect(res.body).toContain(spoken);
  expect(res.body).toContain('<Hangup />');
});

test('a missing auth token rejects calls and warns once', async () => {
  const harness = createHarness({ authToken: '' });

  await harness.post('webhook', CALL);
  await harness.post('webhook', { ...CALL, CallSid: 'CA124' });

  const tokenWarnings = harness.logger.warn.mock.calls.filter(
    ([message]) =>
      typeof message === 'string' && message.includes('TWILIO_AUTH_TOKEN'),
  );
  expect(tokenWarnings).toHaveLength(1);
});

test('a relay turn streams the agent reply as speech tokens and normalizes approval speech', async () => {
  const harness = createHarness({
    dispatch: async (request) => {
      request.onTextDelta?.('**Approved**. Running ');
      request.onTextDelta?.('the [report](https://example.com) now.');
      return { status: 'success', result: 'ignored once streamed' } as never;
    },
  });
  await harness.post('webhook', CALL);
  const { socket } = await harness.upgrade('relay');

  socket.receive({ type: 'setup', callSid: 'CA123', from: CALL.From, to: CALL.To });
  socket.receive({ type: 'prompt', voicePrompt: 'Yes, for the', last: false });
  socket.receive({ type: 'prompt', voicePrompt: 'Yes, for the session.', last: true });
  await settle();

  expect(harness.api.dispatchInboundMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: 'agent:main:channel:voice:chat:dm:peer:ca123',
      channelId: 'voice:CA123',
      userId: CALL.From,
      content: 'yes for session',
      agentId: 'main',
    }),
  );
  expect(socket.sent.map((frame) => [frame.token, frame.last])).toEqual([
    ['Approved.', false],
    ['Running the report now.', true],
  ]);
});

test('each call answers with the default agent current when it started', async () => {
  const harness = createHarness();
  await harness.post('webhook', CALL);
  const first = (await harness.upgrade('relay')).socket;
  first.receive({ type: 'setup', callSid: 'CA123', from: CALL.From, to: CALL.To });

  harness.agents.defaultAgentId = 'support';
  await harness.post('webhook', { ...CALL, CallSid: 'CA456' });
  const second = (await harness.upgrade('relay')).socket;
  second.receive({ type: 'setup', callSid: 'CA456', from: CALL.From, to: CALL.To });
  first.receive({ type: 'prompt', voicePrompt: 'Hi', last: true });
  second.receive({ type: 'prompt', voicePrompt: 'Hi', last: true });
  await settle();

  const turns = harness.api.dispatchInboundMessage.mock.calls.map(
    ([request]) => [request.agentId, request.sessionId],
  );
  expect(turns).toEqual([
    ['main', 'agent:main:channel:voice:chat:dm:peer:ca123'],
    ['support', 'agent:support:channel:voice:chat:dm:peer:ca456'],
  ]);
});

test.each([
  {
    case: 'deltas stop mid-sentence',
    deltas: ['Hello **from'],
    result: 'Hello **from the gateway**. All set.',
    spoken: ['Hello from the gateway. All set.'],
  },
  {
    case: 'narration precedes a cut-off final segment',
    deltas: ['Let me check. ', 'It is '],
    result: 'It is five **pm**.',
    spoken: ['Let me check.', 'It is five pm.'],
  },
  {
    case: 'the reply was rewritten after streaming',
    deltas: ['Draft answer.'],
    result: 'Guarded answer.',
    spoken: ['Draft answer.'],
  },
  {
    case: 'a delta arrives after the turn returned',
    deltas: ['Done.'],
    late: ' Extra.',
    result: 'Done.',
    spoken: ['Done.'],
  },
])('a relay turn speaks the undelivered reply when $case', async ({
  deltas,
  late,
  result,
  spoken,
}) => {
  let lateDelta: ((delta: string) => void) | undefined;
  const harness = createHarness({
    dispatch: async (request) => {
      for (const delta of deltas) request.onTextDelta?.(delta);
      lateDelta = request.onTextDelta;
      return { status: 'success', result } as never;
    },
  });
  await harness.post('webhook', CALL);
  const { socket } = await harness.upgrade('relay');

  socket.receive({ type: 'setup', callSid: 'CA123', from: CALL.From, to: CALL.To });
  socket.receive({ type: 'prompt', voicePrompt: 'What time is it?', last: true });
  await settle();
  if (late) lateDelta?.(late);
  await settle();

  expect(socket.sent.map((frame) => frame.token)).toEqual(spoken);
  expect(socket.sent.at(-1)?.last).toBe(true);
});

test.each([
  { case: 'streams nothing', deltas: [], spoken: [] },
  {
    case: 'streams narration first',
    deltas: ['Let me send that. '],
    spoken: ['Let me send that.'],
  },
])('a relay turn that $case speaks the pending approval prompt', async ({
  deltas,
  spoken,
}) => {
  const harness = createHarness({
    dispatch: async (request) => {
      for (const delta of deltas) request.onTextDelta?.(delta);
      return {
        status: 'success',
        result: 'raw',
        pendingApproval: {
          approvalId: 'appr-1',
          intent: 'send the **invoice**',
          reason: 'it emails a customer',
        },
      } as never;
    },
  });
  await harness.post('webhook', CALL);
  const { socket } = await harness.upgrade('relay');

  socket.receive({ type: 'setup', callSid: 'CA123', from: CALL.From, to: CALL.To });
  socket.receive({ type: 'prompt', voicePrompt: 'Send it', last: true });
  await settle();

  const tokens = socket.sent.map((frame) => frame.token).join(' ');
  expect(tokens.startsWith(spoken.join(' '))).toBe(true);
  expect(tokens).toContain('Approval ID: appr-1');
  expect(socket.sent.at(-1)?.last).toBe(true);
});

test('a dropped relay socket keeps the running agent turn alive', async () => {
  let release: () => void = () => {};
  let observed: AbortSignal | undefined;
  const harness = createHarness({
    dispatch: async (request) => {
      observed = request.abortSignal;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { status: 'success', result: 'Late answer.' } as never;
    },
  });
  await harness.post('webhook', CALL);
  const { socket } = await harness.upgrade('relay');

  socket.receive({ type: 'setup', callSid: 'CA123', from: CALL.From, to: CALL.To });
  socket.receive({ type: 'prompt', voicePrompt: 'hello there', last: true });
  await settle();
  socket.close();
  await settle();

  expect(observed?.aborted).toBe(false);
  release();
  await settle();
  expect(observed?.aborted).toBe(false);
});

test('relay upgrades need a valid signature and the relay mode', async () => {
  const forged = await createHarness().upgrade('relay', 'forged');
  const realtimeHarness = createHarness();
  realtimeHarness.voice.mode = 'realtime';
  const wrongMode = await realtimeHarness.upgrade('relay');

  expect(forged.rejections).toEqual([[403, 'Forbidden']]);
  expect(wrongMode.rejections).toEqual([[404, 'Not Found']]);
});

test('a realtime stream passes µ-law audio straight through to the realtime session', async () => {
  const harness = createHarness();
  harness.voice.mode = 'realtime';
  await harness.post('webhook', CALL);
  const { socket, rejections } = await harness.upgrade('stream');
  const callerAudio = Buffer.from([0xff, 0x7f, 0x00, 0x80]);

  socket.receive({ event: 'connected' });
  socket.receive({
    event: 'start',
    streamSid: 'MZ1',
    start: { callSid: 'CA123', customParameters: { callReference: 'CA123' } },
  });
  socket.receive({
    event: 'media',
    streamSid: 'MZ1',
    media: { payload: callerAudio.toString('base64') },
  });
  socket.receive({ event: 'dtmf', streamSid: 'MZ1', dtmf: { digit: '7' } });

  expect(rejections).toEqual([]);
  const options = harness.api.createRealtimeVoiceSession.mock.calls[0][0] as {
    audioEncoding: string;
    session: { sessionId: string; channelId: string };
    sendAudio: (frame: Buffer) => void;
    clearAudio: () => void;
  };
  expect(options).toMatchObject({
    audioEncoding: 'mulaw',
    caller: { from: CALL.From, to: CALL.To },
    session: {
      sessionId: 'agent:main:channel:voice:chat:dm:peer:ca123',
      channelId: 'voice:CA123',
    },
  });
  expect(harness.realtimeSession.handleCallerAudio).toHaveBeenCalledWith(
    callerAudio,
  );
  expect(harness.realtimeSession.handleDtmf).toHaveBeenCalledWith('7');

  options.sendAudio(Buffer.from([1, 2, 3]));
  options.clearAudio();
  expect(socket.sent).toEqual([
    {
      event: 'media',
      streamSid: 'MZ1',
      media: { payload: Buffer.from([1, 2, 3]).toString('base64') },
    },
    { event: 'clear', streamSid: 'MZ1' },
  ]);

  socket.receive({ event: 'stop', streamSid: 'MZ1' });
  expect(harness.realtimeSession.close).toHaveBeenCalled();
});

test('a stream for a call the plugin never answered is closed', async () => {
  const harness = createHarness();
  harness.voice.mode = 'realtime';
  const { socket } = await harness.upgrade('stream');

  socket.receive({
    event: 'start',
    streamSid: 'MZ1',
    start: { callSid: 'CA-unknown' },
  });

  expect(harness.api.createRealtimeVoiceSession).not.toHaveBeenCalled();
  expect(socket.closed).toBe(true);
});

test('the action callback reissues TwiML once for a dropped relay, then ends the call', async () => {
  const harness = createHarness();
  await harness.post('webhook', CALL);
  const dropped = {
    ...CALL,
    SessionStatus: 'failed',
    CallStatus: 'in-progress',
    ErrorMessage: 'websocket closed',
  };

  const reconnect = await harness.post('action', dropped);
  const second = await harness.post('action', dropped);

  expect(reconnect.body).toContain('<ConversationRelay');
  expect(second.body).toBe(
    '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
  );
  const busy = createHarness();
  busy.voice.maxConcurrentCalls = 1;
  await busy.post('webhook', CALL);
  await busy.post('action', { ...CALL, SessionStatus: 'ended' });
  expect(
    (await busy.post('webhook', { ...CALL, CallSid: 'CA2' })).body,
  ).toContain('<ConversationRelay');
});

test('stopping the plugin ends live relay calls', async () => {
  const harness = createHarness();
  await harness.post('webhook', CALL);
  const { socket } = await harness.upgrade('relay');
  socket.receive({ type: 'setup', callSid: 'CA123', from: CALL.From, to: CALL.To });
  await settle();

  await harness.services[0].stop?.();

  expect(socket.sent.at(-1)).toEqual({
    type: 'end',
    handoffData: JSON.stringify({ reason: 'gateway-shutdown' }),
  });
  expect(socket.closed).toBe(true);
  expect((await harness.post('webhook', CALL)).body).toContain(
    'HybridClaw voice is unavailable right now.',
  );
});

test('voice call dials through the Twilio REST API with the plugin webhook', async () => {
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    expect(String(url)).toBe(
      'https://api.twilio.com/2010-04-01/Accounts/AC123/Calls.json',
    );
    expect(init?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from(`AC123:${AUTH_TOKEN}`).toString('base64')}`,
    });
    const params = new URLSearchParams(String(init?.body));
    expect(Object.fromEntries(params)).toEqual({
      To: '+4915123456789',
      From: '+14155550123',
      Url: `${PUBLIC_BASE}${WEBHOOK_PATH}`,
      Method: 'POST',
    });
    return new Response(
      JSON.stringify({
        sid: 'CA999',
        status: 'queued',
        to: '+4915123456789',
        from: '+14155550123',
      }),
      { status: 201 },
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  const harness = createHarness();

  await expect(
    harness.commands[0].handler(['call', '+49 151', '23456789'], {} as never),
  ).resolves.toBe(
    'Calling +4915123456789 from +14155550123 via Twilio (Call SID: CA999, status: queued).',
  );
});

test('voice call refuses to dial when Twilio cannot reach the gateway', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const harness = createHarness({ publicBaseUrl: null });

  await expect(
    harness.commands[0].handler(['call', '+4915123456789'], {} as never),
  ).rejects.toThrow('Set `ops.gatewayBaseUrl`');
  expect(fetchMock).not.toHaveBeenCalled();
});
