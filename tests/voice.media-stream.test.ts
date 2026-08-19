import { expect, test } from 'vitest';
import {
  buildMediaStreamClearPayload,
  buildMediaStreamMarkPayload,
  buildMediaStreamMediaPayload,
  parseMediaStreamMessage,
} from '../src/channels/voice/media-stream.js';
import { buildMediaStreamTwiml } from '../src/channels/voice/webhook.js';

test('parseMediaStreamMessage decodes the media stream event lifecycle', () => {
  const connected = parseMediaStreamMessage(
    JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }),
  );
  const start = parseMediaStreamMessage(
    JSON.stringify({
      event: 'start',
      sequenceNumber: '1',
      streamSid: 'MZ123',
      start: {
        streamSid: 'MZ123',
        accountSid: 'AC123',
        callSid: 'CA123',
        tracks: ['inbound'],
        customParameters: { callReference: 'CA123' },
        mediaFormat: {
          encoding: 'audio/x-mulaw',
          sampleRate: 8000,
          channels: 1,
        },
      },
    }),
  );
  const media = parseMediaStreamMessage(
    JSON.stringify({
      event: 'media',
      streamSid: 'MZ123',
      media: {
        track: 'inbound',
        chunk: '2',
        timestamp: '20',
        payload: 'dGVzdA==',
      },
    }),
  );
  const dtmf = parseMediaStreamMessage(
    JSON.stringify({
      event: 'dtmf',
      streamSid: 'MZ123',
      dtmf: { track: 'inbound_track', digit: '5' },
    }),
  );
  const mark = parseMediaStreamMessage(
    JSON.stringify({
      event: 'mark',
      streamSid: 'MZ123',
      mark: { name: 'checkpoint' },
    }),
  );
  const stop = parseMediaStreamMessage(
    JSON.stringify({
      event: 'stop',
      streamSid: 'MZ123',
      stop: { accountSid: 'AC123', callSid: 'CA123' },
    }),
  );

  expect(connected).toEqual({ type: 'connected' });
  expect(start).toEqual({
    type: 'start',
    streamSid: 'MZ123',
    callSid: 'CA123',
    accountSid: 'AC123',
    customParameters: { callReference: 'CA123' },
  });
  expect(media).toEqual({
    type: 'media',
    streamSid: 'MZ123',
    payload: 'dGVzdA==',
  });
  expect(dtmf).toEqual({ type: 'dtmf', streamSid: 'MZ123', digit: '5' });
  expect(mark).toEqual({ type: 'mark', streamSid: 'MZ123', name: 'checkpoint' });
  expect(stop).toEqual({ type: 'stop', streamSid: 'MZ123', callSid: 'CA123' });
});

test('parseMediaStreamMessage rejects malformed payloads', () => {
  expect(() => parseMediaStreamMessage('')).toThrow(/empty/);
  expect(() => parseMediaStreamMessage('not json')).toThrow(/valid JSON/);
  expect(() => parseMediaStreamMessage('"scalar"')).toThrow(/JSON object/);
  expect(() =>
    parseMediaStreamMessage(JSON.stringify({ event: 'unknown-event' })),
  ).toThrow(/Unsupported media stream event/);
});

test('outbound media stream payload builders produce Twilio frames', () => {
  expect(buildMediaStreamMediaPayload('MZ123', 'dGVzdA==')).toEqual({
    event: 'media',
    streamSid: 'MZ123',
    media: { payload: 'dGVzdA==' },
  });
  expect(buildMediaStreamClearPayload('MZ123')).toEqual({
    event: 'clear',
    streamSid: 'MZ123',
  });
  expect(buildMediaStreamMarkPayload('MZ123', 'checkpoint')).toEqual({
    event: 'mark',
    streamSid: 'MZ123',
    mark: { name: 'checkpoint' },
  });
});

test('buildMediaStreamTwiml renders a bidirectional Connect Stream', () => {
  const xml = buildMediaStreamTwiml({
    websocketUrl: 'wss://voice.example.com/voice/stream',
    actionUrl: 'https://voice.example.com/voice/action',
    customParameters: { callReference: 'CA123' },
  });

  expect(xml).toContain(
    '<Connect action="https://voice.example.com/voice/action">',
  );
  expect(xml).toContain('<Stream url="wss://voice.example.com/voice/stream">');
  expect(xml).toContain('<Parameter name="callReference" value="CA123" />');
  expect(xml).toContain('</Connect>');
});
