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
  expect(
    validateTwilioSignature({
      authToken,
      signature: '',
      url,
      values,
    }),
  ).toBe(false);
  expect(
    validateTwilioSignature({
      authToken,
      signature: undefined,
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

test('buildTwilioSignature matches captured Twilio voice webhook signatures', () => {
  const authToken = 'secret';
  const url = 'https://example.com/voice/webhook';
  const values = Object.fromEntries(
    new URLSearchParams(
      'Called=%2B491703330161&ToState=&CallerCountry=US&Direction=outbound-api&CallerState=CA&ToZip=&CallSid=test-call-sid&To=%2B491703330161&CallerZip=&ToCountry=DE&CalledZip=&ApiVersion=2010-04-01&CalledCity=&CallStatus=in-progress&From=%2B16505055892&AccountSid=test-account-sid&CalledCountry=DE&CallerCity=&ToCity=&FromCountry=US&Caller=%2B16505055892&FromCity=&CalledState=&FromZip=&FromState=CA',
    ),
  );

  expect(
    buildTwilioSignature({
      authToken,
      url,
      values,
    }),
  ).toBe('KOEOMoF/g4CsG6Eh3lIavri38Oc=');
});
