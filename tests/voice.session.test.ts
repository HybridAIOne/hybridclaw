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
  store.transition('CA123', 'relay-connecting');
  store.transition('CA123', 'setup-received');
  store.transition('CA123', 'listening');
  store.transition('CA123', 'interrupted');

  expect(store.get('CA123')?.state).toBe('interrupted');
});
