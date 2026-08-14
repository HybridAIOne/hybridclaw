import { expect, test } from 'vitest';
import {
  buildGoodbyeNcco,
  buildParkNcco,
  buildReplyNcco,
  parseVonageAnswerWebhook,
  parseVonageEventWebhook,
  parseVonageInputWebhook,
} from '../plugins/vonage-voice/src/ncco.js';

const SPEECH_SETTINGS = {
  language: 'en-US',
  inputEventUrl: 'https://voice.example.com/voice/input',
};

test('buildReplyNcco emits talk followed by a speech input action', () => {
  const ncco = buildReplyNcco({
    text: 'Hello caller.',
    interruptible: true,
    ...SPEECH_SETTINGS,
  });
  expect(ncco).toHaveLength(2);
  expect(ncco[0]).toMatchObject({
    action: 'talk',
    text: 'Hello caller.',
    language: 'en-US',
    bargeIn: true,
  });
  expect(ncco[1]).toMatchObject({
    action: 'input',
    type: ['speech'],
    eventUrl: ['https://voice.example.com/voice/input'],
    eventMethod: 'POST',
  });
  const speech = (ncco[1] as { speech: Record<string, unknown> }).speech;
  expect(speech.language).toBe('en-US');
  expect(speech.maxDuration).toBe(60);
});

test('buildReplyNcco chunks talk text beyond the 1500 char limit', () => {
  const sentence = 'This is a fairly long sentence for chunking. ';
  const text = sentence.repeat(80).trim();
  const ncco = buildReplyNcco({
    text,
    interruptible: false,
    ...SPEECH_SETTINGS,
  });
  const talks = ncco.filter((action) => action.action === 'talk');
  expect(talks.length).toBeGreaterThan(1);
  for (const talk of talks) {
    expect(String(talk.text).length).toBeLessThanOrEqual(1500);
  }
  expect(talks.map((talk) => talk.text).join(' ')).toBe(text);
  expect(ncco[ncco.length - 1]).toMatchObject({ action: 'input' });
});

test('buildParkNcco only listens and buildGoodbyeNcco only talks', () => {
  const park = buildParkNcco(SPEECH_SETTINGS);
  expect(park).toHaveLength(1);
  expect(park[0]).toMatchObject({ action: 'input' });

  const goodbye = buildGoodbyeNcco({ message: 'Bye.', language: 'en-US' });
  expect(goodbye).toHaveLength(1);
  expect(goodbye[0]).toMatchObject({
    action: 'talk',
    text: 'Bye.',
    bargeIn: false,
  });
});

test('parseVonageAnswerWebhook extracts call identity fields', () => {
  expect(
    parseVonageAnswerWebhook({
      uuid: 'call-1',
      conversation_uuid: 'CON-1',
      from: '15550001111',
      to: '15550002222',
      region_url: 'https://api-eu-3.vonage.com',
    }),
  ).toEqual({
    uuid: 'call-1',
    conversationUuid: 'CON-1',
    from: '15550001111',
    to: '15550002222',
    regionUrl: 'https://api-eu-3.vonage.com',
  });
  expect(parseVonageAnswerWebhook({ from: 'x' })).toBeNull();
  expect(parseVonageAnswerWebhook('nope')).toBeNull();
});

test('parseVonageInputWebhook extracts speech results, timeouts, and DTMF', () => {
  expect(
    parseVonageInputWebhook({
      uuid: 'call-1',
      conversation_uuid: 'CON-1',
      speech: {
        results: [{ text: 'hello there', confidence: '0.9' }],
      },
    }),
  ).toMatchObject({ uuid: 'call-1', transcript: 'hello there', timedOut: false });

  expect(
    parseVonageInputWebhook({
      uuid: 'call-1',
      speech: { timeout_reason: 'start_timeout', results: [] },
    }),
  ).toMatchObject({ transcript: '', timedOut: true });

  expect(
    parseVonageInputWebhook({
      uuid: 'call-1',
      dtmf: { digits: '42', timed_out: false },
    }),
  ).toMatchObject({ dtmfDigits: '42' });
});

test('parseVonageEventWebhook normalizes status and accepts call_uuid', () => {
  expect(
    parseVonageEventWebhook({
      uuid: 'call-1',
      conversation_uuid: 'CON-1',
      status: 'Completed',
    }),
  ).toEqual({ uuid: 'call-1', conversationUuid: 'CON-1', status: 'completed' });
  expect(
    parseVonageEventWebhook({ call_uuid: 'call-2', status: 'human' }),
  ).toMatchObject({ uuid: 'call-2' });
  expect(parseVonageEventWebhook({ status: 'completed' })).toBeNull();
});
