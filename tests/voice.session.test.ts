import { expect, test } from 'vitest';
import { VoiceCallSessionStore } from '../src/channels/voice/session.js';

test('voice sessions allow listening to interrupted transitions', () => {
  const store = new VoiceCallSessionStore(8, 32, 16);
  const session = store.getOrCreateFromWebhook({
    callSid: 'CA123',
    remoteIp: '127.0.0.1',
    from: '+14155550123',
    to: '+14155550124',
  });

  expect(session).not.toBeNull();

  store.transition('CA123', 'twiml-issued');
  store.transition('CA123', 'listening');
  store.transition('CA123', 'interrupted');

  expect(store.get('CA123')?.state).toBe('interrupted');
});

test('voice sessions allow setup to go straight from initiated to listening', () => {
  const store = new VoiceCallSessionStore(8, 32, 16);
  const session = store.getOrCreateFromWebhook({
    callSid: 'CA124',
    remoteIp: '127.0.0.1',
    from: '+14155550123',
    to: '+14155550124',
  });

  expect(session).not.toBeNull();

  store.transition('CA124', 'listening');

  expect(store.get('CA124')?.state).toBe('listening');
});

test('voice session capacity opens again after a call reaches a terminal state', () => {
  const store = new VoiceCallSessionStore(1, 32, 16);

  const first = store.getOrCreateFromWebhook({
    callSid: 'CA125',
    remoteIp: '127.0.0.1',
    from: '+14155550123',
    to: '+14155550124',
  });
  const blocked = store.getOrCreateFromWebhook({
    callSid: 'CA126',
    remoteIp: '127.0.0.1',
    from: '+14155550125',
    to: '+14155550126',
  });

  expect(first).not.toBeNull();
  expect(blocked).toBeNull();
  expect(store.activeCount()).toBe(1);

  store.transition('CA125', 'failed');

  expect(store.activeCount()).toBe(0);
  expect(
    store.getOrCreateFromWebhook({
      callSid: 'CA126',
      remoteIp: '127.0.0.1',
      from: '+14155550125',
      to: '+14155550126',
    }),
  ).not.toBeNull();
});
