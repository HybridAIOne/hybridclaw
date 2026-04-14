import { expect, test } from 'vitest';
import {
  buildConversationRelayTwiml,
  buildHangupTwiml,
} from '../src/channels/voice/webhook.js';

test('buildConversationRelayTwiml renders ConversationRelay with configured attributes', () => {
  const xml = buildConversationRelayTwiml({
    websocketUrl: 'wss://voice.example.com/voice/relay',
    actionUrl: 'https://voice.example.com/voice/action',
    relay: {
      ttsProvider: 'google',
      voice: 'en-US-Journey-D',
      transcriptionProvider: 'deepgram',
      language: 'en-US',
      interruptible: true,
      welcomeGreeting: 'Hello there!',
    },
    customParameters: {
      callReference: 'CA123',
    },
  });

  expect(xml).toContain(
    '<Connect action="https://voice.example.com/voice/action">',
  );
  expect(xml).toContain(
    '<ConversationRelay url="wss://voice.example.com/voice/relay"',
  );
  expect(xml).toContain('welcomeGreeting="Hello there!"');
  expect(xml).toContain('welcomeGreetingInterruptible="any"');
  expect(xml).toContain('ttsProvider="Google"');
  expect(xml).toContain('voice="en-US-Journey-D"');
  expect(xml).toContain('transcriptionProvider="Deepgram"');
  expect(xml).toContain('interruptible="any"');
  expect(xml).toContain('reportInputDuringAgentSpeech="none"');
  expect(xml).toContain('<Parameter name="callReference" value="CA123" />');
});

test('buildHangupTwiml escapes XML content', () => {
  const xml = buildHangupTwiml('Voice & support <busy>');
  expect(xml).toContain('Voice &amp; support &lt;busy&gt;');
  expect(xml).toContain('<Hangup />');
});
