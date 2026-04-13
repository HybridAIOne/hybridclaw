import { expect, test } from 'vitest';
import {
  ConversationRelayResponseStream,
  mergePromptFragment,
  parseConversationRelayMessage,
} from '../src/channels/voice/conversation-relay.js';

test('parseConversationRelayMessage decodes setup and prompt payloads', () => {
  const setup = parseConversationRelayMessage(
    JSON.stringify({
      type: 'setup',
      sessionId: 'VX123',
      accountSid: 'AC123',
      callSid: 'CA123',
      from: '+14155550123',
      to: '+14155550124',
      customParameters: {
        callReference: 'CA123',
      },
    }),
  );
  const prompt = parseConversationRelayMessage(
    JSON.stringify({
      type: 'prompt',
      voicePrompt: 'Hello from caller',
      lang: 'en-US',
      last: true,
    }),
  );

  expect(setup.type).toBe('setup');
  expect(setup.callSid).toBe('CA123');
  expect(setup.customParameters).toEqual({ callReference: 'CA123' });
  expect(prompt).toEqual({
    type: 'prompt',
    voicePrompt: 'Hello from caller',
    lang: 'en-US',
    last: true,
  });
});

test('mergePromptFragment handles incremental and cumulative prompt fragments', () => {
  expect(mergePromptFragment('', 'Hello')).toBe('Hello');
  expect(mergePromptFragment('Hello', ' world')).toBe('Hello world');
  expect(mergePromptFragment('Hello', 'Hello world')).toBe('Hello world');
});

test('ConversationRelayResponseStream buffers the final token until finish', async () => {
  const payloads: Array<Record<string, unknown>> = [];
  const stream = new ConversationRelayResponseStream(
    async (payload) => {
      payloads.push(payload);
    },
    {
      interruptible: true,
      language: 'en-US',
    },
  );

  await stream.push('Hello');
  await stream.push(' world');
  await stream.finish();

  expect(payloads).toEqual([
    {
      type: 'text',
      token: 'Hello',
      last: false,
      lang: 'en-US',
      interruptible: true,
      preemptible: false,
    },
    {
      type: 'text',
      token: ' world',
      last: true,
      lang: 'en-US',
      interruptible: true,
      preemptible: false,
    },
  ]);
});

test('ConversationRelayResponseStream can send a single reply and end the session', async () => {
  const payloads: Array<Record<string, unknown>> = [];
  const stream = new ConversationRelayResponseStream(
    async (payload) => {
      payloads.push(payload);
    },
    {
      interruptible: false,
      language: 'en-US',
    },
  );

  await stream.reply('Goodbye');
  expect(payloads[0]).toMatchObject({
    type: 'text',
    token: 'Goodbye',
    last: true,
    interruptible: false,
  });

  const endStream = new ConversationRelayResponseStream(
    async (payload) => {
      payloads.push(payload);
    },
    {
      interruptible: false,
      language: 'en-US',
    },
  );
  await endStream.endSession('{"reason":"handoff"}');

  expect(payloads.at(-1)).toEqual({
    type: 'end',
    handoffData: '{"reason":"handoff"}',
  });
});
