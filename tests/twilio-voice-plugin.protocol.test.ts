import { expect, test } from 'vitest';
import {
  ConversationRelayResponseStream,
  mergePromptFragment,
  parseConversationRelayMessage,
} from '../plugins/twilio-voice/src/conversation-relay.js';
import {
  buildClearPayload,
  buildMediaPayload,
  parseMediaStreamMessage,
} from '../plugins/twilio-voice/src/media-stream.js';
import {
  buildTwilioSignature,
  createReplayProtector,
  validateTwilioSignature,
} from '../plugins/twilio-voice/src/security.js';
import { createSessionStore } from '../plugins/twilio-voice/src/session-store.js';
import {
  createSpeechChunker,
  normalizeCallerSpeech,
} from '../plugins/twilio-voice/src/text.js';
import {
  buildConversationRelayTwiml,
  buildHangupTwiml,
  buildMediaStreamTwiml,
} from '../plugins/twilio-voice/src/twiml.js';
import { formatTextForVoice } from '../src/voice/text.js';

const RELAY = {
  ttsProvider: 'google',
  voice: 'en-US-Journey-D',
  transcriptionProvider: 'deepgram',
  language: 'en-US',
  interruptible: true,
  welcomeGreeting: 'Hello there!',
};

function textFrame(token: string, last: boolean, interruptible = true) {
  return {
    type: 'text',
    token,
    last,
    lang: 'en-US',
    interruptible,
    preemptible: false,
  };
}

test('validateTwilioSignature accepts only the matching signature', () => {
  const authToken = 'test-key';
  const url = 'https://example.com/api/plugin-webhooks/twilio-voice/webhook';
  const values = { CallSid: 'CA123', From: '+14155550123' };
  const signature = buildTwilioSignature({ authToken, url, values });

  expect(validateTwilioSignature({ authToken, signature, url, values })).toBe(
    true,
  );
  for (const forged of ['invalid', '', undefined]) {
    expect(
      validateTwilioSignature({ authToken, signature: forged, url, values }),
    ).toBe(false);
  }
  expect(
    validateTwilioSignature({
      authToken,
      signature,
      url: `${url}?tampered=1`,
      values,
    }),
  ).toBe(false);
});

test('validateTwilioSignature rejects every signature when no auth token is set', () => {
  const url = 'https://example.com/api/plugin-webhooks/twilio-voice/webhook';
  const signature = buildTwilioSignature({ authToken: '', url });

  expect(validateTwilioSignature({ authToken: '', signature, url })).toBe(
    false,
  );
});

test('buildTwilioSignature matches a captured Twilio voice webhook signature', () => {
  const values = Object.fromEntries(
    new URLSearchParams(
      'Called=%2B491703330161&ToState=&CallerCountry=US&Direction=outbound-api&CallerState=CA&ToZip=&CallSid=test-call-sid&To=%2B491703330161&CallerZip=&ToCountry=DE&CalledZip=&ApiVersion=2010-04-01&CalledCity=&CallStatus=in-progress&From=%2B16505055892&AccountSid=test-account-sid&CalledCountry=DE&CallerCity=&ToCity=&FromCountry=US&Caller=%2B16505055892&FromCity=&CalledState=&FromZip=&FromState=CA',
    ),
  );

  expect(
    buildTwilioSignature({
      authToken: 'secret',
      url: 'https://example.com/voice/webhook',
      values,
    }),
  ).toBe('KOEOMoF/g4CsG6Eh3lIavri38Oc=');
});

test('the replay protector refuses a token seen inside its window', () => {
  const replay = createReplayProtector(30_000);

  expect(replay.observe('abc123')).toBe(true);
  expect(replay.observe('abc123')).toBe(false);
  expect(replay.observe('different')).toBe(true);
  expect(replay.observe('')).toBe(true);
  expect(replay.observe('')).toBe(true);
});

test('ConversationRelay TwiML carries the relay settings and call reference', () => {
  const xml = buildConversationRelayTwiml({
    websocketUrl: 'wss://voice.example.com/relay',
    actionUrl: 'https://voice.example.com/action',
    relay: RELAY,
    customParameters: { callReference: 'CA123' },
  });

  expect(xml).toContain('<Connect action="https://voice.example.com/action">');
  expect(xml).toContain('<ConversationRelay url="wss://voice.example.com/relay"');
  for (const attribute of [
    'welcomeGreeting="Hello there!"',
    'welcomeGreetingInterruptible="any"',
    'ttsProvider="Google"',
    'voice="en-US-Journey-D"',
    'transcriptionProvider="Deepgram"',
    'interruptible="any"',
    'reportInputDuringAgentSpeech="none"',
  ]) {
    expect(xml).toContain(attribute);
  }
  expect(xml).toContain('<Parameter name="callReference" value="CA123" />');
});

test('ConversationRelay TwiML refuses an unknown provider instead of defaulting', () => {
  expect(() =>
    buildConversationRelayTwiml({
      websocketUrl: 'wss://voice.example.com/relay',
      actionUrl: 'https://voice.example.com/action',
      relay: { ...RELAY, ttsProvider: 'acme' },
    }),
  ).toThrow('Unsupported voice.relay.ttsProvider: acme');
});

test('Media Stream TwiML connects a bidirectional stream', () => {
  const xml = buildMediaStreamTwiml({
    websocketUrl: 'wss://voice.example.com/stream',
    actionUrl: 'https://voice.example.com/action',
    customParameters: { callReference: 'CA123' },
  });

  expect(xml).toContain('<Stream url="wss://voice.example.com/stream">');
  expect(xml).toContain('<Parameter name="callReference" value="CA123" />');
});

test('hangup TwiML escapes the spoken message', () => {
  const xml = buildHangupTwiml('Voice & support <busy>');

  expect(xml).toContain('Voice &amp; support &lt;busy&gt;');
  expect(xml).toContain('<Hangup />');
});

test('parseMediaStreamMessage decodes the stream lifecycle', () => {
  const frame = (payload: Record<string, unknown>) =>
    parseMediaStreamMessage(JSON.stringify(payload));

  expect(frame({ event: 'connected', protocol: 'Call' })).toEqual({
    type: 'connected',
  });
  expect(
    frame({
      event: 'start',
      streamSid: 'MZ123',
      start: {
        callSid: 'CA123',
        customParameters: { callReference: 'CA123' },
      },
    }),
  ).toEqual({
    type: 'start',
    streamSid: 'MZ123',
    callSid: 'CA123',
    customParameters: { callReference: 'CA123' },
  });
  expect(
    frame({ event: 'media', streamSid: 'MZ123', media: { payload: 'dGVzdA==' } }),
  ).toEqual({ type: 'media', streamSid: 'MZ123', payload: 'dGVzdA==' });
  expect(
    frame({ event: 'dtmf', streamSid: 'MZ123', dtmf: { digit: '5' } }),
  ).toEqual({ type: 'dtmf', streamSid: 'MZ123', digit: '5' });
  expect(frame({ event: 'stop', streamSid: 'MZ123' })).toEqual({
    type: 'stop',
    streamSid: 'MZ123',
  });
});

test.each([
  ['', /empty/],
  ['not json', /valid JSON/],
  ['"scalar"', /JSON object/],
  [JSON.stringify({ event: 'unknown-event' }), /Unsupported media stream event/],
])('parseMediaStreamMessage rejects %j', (raw, error) => {
  expect(() => parseMediaStreamMessage(raw)).toThrow(error);
});

test('outbound media stream frames match the Twilio wire format', () => {
  expect(buildMediaPayload('MZ123', 'dGVzdA==')).toEqual({
    event: 'media',
    streamSid: 'MZ123',
    media: { payload: 'dGVzdA==' },
  });
  expect(buildClearPayload('MZ123')).toEqual({
    event: 'clear',
    streamSid: 'MZ123',
  });
});

test('parseConversationRelayMessage decodes setup and prompt payloads', () => {
  const setup = parseConversationRelayMessage(
    JSON.stringify({
      type: 'setup',
      callSid: 'CA123',
      from: '+14155550123',
      to: '+14155550124',
      customParameters: { callReference: 'CA123' },
    }),
  );

  expect(setup).toMatchObject({
    type: 'setup',
    callSid: 'CA123',
    customParameters: { callReference: 'CA123' },
  });
  expect(
    parseConversationRelayMessage(
      JSON.stringify({ type: 'prompt', voicePrompt: 'Hi', lang: 'en-US' }),
    ),
  ).toEqual({ type: 'prompt', voicePrompt: 'Hi', lang: 'en-US', last: true });
  expect(() =>
    parseConversationRelayMessage(JSON.stringify({ type: 'telemetry' })),
  ).toThrow('Unsupported ConversationRelay message type: telemetry');
});

test('mergePromptFragment handles incremental and cumulative fragments', () => {
  expect(mergePromptFragment('', 'Hello')).toBe('Hello');
  expect(mergePromptFragment('Hello', ' world')).toBe('Hello world');
  expect(mergePromptFragment('Hello', 'Hello world')).toBe('Hello world');
  expect(mergePromptFragment('Hello', 'there')).toBe('Hello there');
});

test('the relay response stream holds the final token until finish', async () => {
  const payloads: Array<Record<string, unknown>> = [];
  const stream = new ConversationRelayResponseStream(
    async (payload: Record<string, unknown>) => {
      payloads.push(payload);
    },
    { interruptible: true, language: 'en-US' },
  );

  await stream.push('Hello');
  await stream.push(' world');
  await stream.finish();

  expect(payloads).toEqual([
    textFrame('Hello', false),
    textFrame(' world', true),
  ]);
  expect(stream.finished).toBe(true);
});

test('the relay response stream marks the first token only after a send succeeds', async () => {
  let firstTokens = 0;
  const stream = new ConversationRelayResponseStream(
    async () => {
      throw new Error('Voice websocket is not connected.');
    },
    {
      interruptible: true,
      language: 'en-US',
      onFirstToken: () => {
        firstTokens += 1;
      },
    },
  );

  await expect(stream.reply('Hello')).rejects.toThrow(
    'Voice websocket is not connected.',
  );
  expect(firstTokens).toBe(0);
});

test('the relay response stream serializes concurrent writes', async () => {
  const payloads: Array<Record<string, unknown>> = [];
  let releaseFirst: (() => void) | null = null;
  const stream = new ConversationRelayResponseStream(
    async (payload: Record<string, unknown>) => {
      payloads.push(payload);
      if (payload.token === 'Hello' && payload.last === false) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
    },
    { interruptible: true, language: 'en-US' },
  );

  const writes = [stream.push('Hello'), stream.push(' there'), stream.finish()];
  for (let attempt = 0; attempt < 5 && releaseFirst === null; attempt += 1) {
    await Promise.resolve();
  }
  expect(releaseFirst).not.toBeNull();
  releaseFirst?.();
  await Promise.all(writes);

  expect(payloads).toEqual([
    textFrame('Hello', false),
    textFrame(' there', true),
  ]);
});

test('call state moves through the relay cycle and frees capacity at a terminal state', () => {
  const sessions = createSessionStore({ agentId: 'main' });
  const call = (callSid: string) => ({
    callSid,
    remoteIp: '127.0.0.1',
    from: '+14155550123',
    to: '+14155550124',
  });

  const first = sessions.getOrCreate(call('CA1'), 1);
  expect(first).toMatchObject({
    channelId: 'voice:CA1',
    gatewaySessionId: 'agent:main:channel:voice:chat:dm:peer:CA1',
    userId: '+14155550123',
    state: 'initiated',
  });
  expect(sessions.getOrCreate(call('CA2'), 1)).toBeNull();

  for (const state of ['twiml-issued', 'listening', 'interrupted']) {
    sessions.transition('CA1', state);
  }
  expect(() => sessions.transition('CA1', 'twiml-issued')).toThrow(
    'Invalid voice session state transition: interrupted -> twiml-issued',
  );
  sessions.transition('CA1', 'failed');

  expect(sessions.activeCount()).toBe(0);
  expect(sessions.getOrCreate(call('CA2'), 1)).not.toBeNull();
});

test.each([
  ['Yes for a session.', 'yes for session'],
  ['Yes. For session.', 'yes for session'],
  ['Yes for agent.', 'yes for agent'],
  ['Approve, please.', 'yes'],
  ['No.', 'no'],
  ['Skip it!', 'no'],
  [
    "What's the weather going to be in Stockdorf Germany?",
    "What's the weather going to be in Stockdorf Germany?",
  ],
])('normalizeCallerSpeech(%j) -> %j', (spoken, expected) => {
  expect(normalizeCallerSpeech(spoken)).toBe(expected);
});

test('the speech chunker waits for a sentence boundary and strips markdown', () => {
  const chunker = createSpeechChunker(formatTextForVoice);

  expect(chunker.push('**Yes')).toEqual([]);
  expect(chunker.push('** that works.')).toEqual(['Yes that works.']);
  expect(chunker.push(' Next answer')).toEqual([]);
  expect(chunker.flush()).toEqual(['Next answer']);
});

test('the speech chunker cuts long unpunctuated text at whitespace', () => {
  const chunker = createSpeechChunker(formatTextForVoice);

  expect(
    chunker.push(
      'This response keeps streaming without punctuation so it should still flush once it is long enough ',
    ),
  ).toEqual([
    'This response keeps streaming without punctuation so it should still flush once it is long enough',
  ]);
  expect(chunker.flush()).toEqual([]);
});
