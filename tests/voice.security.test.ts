import { expect, test } from 'vitest';
import {
  buildTwilioSignature,
  ReplayProtector,
  validateTwilioSignature,
} from '../src/channels/voice/security.js';

test('validateTwilioSignature accepts matching webhook signatures', () => {
  const authToken = 'secret';
  const url = 'https://example.com/voice/webhook';
  const values = {
    CallSid: 'CA123',
    From: '+14155550123',
    To: '+14155550124',
  };
  const signature = buildTwilioSignature({
    authToken,
    url,
    values,
  });

  expect(
    validateTwilioSignature({
      authToken,
      signature,
      url,
      values,
    }),
  ).toBe(true);
  expect(
    validateTwilioSignature({
      authToken,
      signature: 'invalid',
      url,
      values,
    }),
  ).toBe(false);
});

test('ReplayProtector rejects duplicate tokens inside the TTL window', () => {
  const protector = new ReplayProtector(30_000);

  expect(protector.observe('abc123')).toBe(true);
  expect(protector.observe('abc123')).toBe(false);
  expect(protector.observe('different')).toBe(true);
});
