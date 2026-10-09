import { expect, test } from 'vitest';
import { buildVoiceSessionKey as twilioSessionKey } from '../plugins/twilio-voice/src/utils.js';
import { buildVoiceSessionKey as vonageSessionKey } from '../plugins/vonage-voice/src/utils.js';
import {
  buildSessionKey,
  classifySessionKeyShape,
} from '../src/session/session-key.js';

// Plugins cannot import core at runtime, so each phone transport carries a
// copy of the voice session-key shape; this is the check that keeps the
// copies equal to the core builder.
test.each([
  { plugin: 'twilio-voice', build: twilioSessionKey },
  { plugin: 'vonage-voice', build: vonageSessionKey },
])('$plugin builds the same voice session key as core', ({ build }) => {
  for (const [agentId, callId] of [
    ['main', 'CA0123456789abcdef0123456789ABCDEF'],
    ['Team Lead', ' 63f61863-4a51-4f6b-86e1-46edebcf9356 '],
    ['ops/eu', 'call:with/odd chars'],
  ]) {
    const key = build(agentId, callId);

    expect(key).toBe(buildSessionKey(agentId, 'voice', 'dm', callId));
    expect(classifySessionKeyShape(key)).toBe('canonical');
  }
});
