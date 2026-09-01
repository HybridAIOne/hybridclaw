import { expect, test } from 'vitest';

import {
  isCallerAllowed,
  isCallerPolicy,
  normalizeCallerAllowList,
  normalizeCallerIdentity,
} from '../plugins/vonage-voice/src/caller-policy.js';

const LISTED = '+4915123456789';

test('open accepts every caller and disabled rejects every caller', () => {
  expect(
    isCallerAllowed({ callerPolicy: 'open', allowFrom: [], from: '4915999999' }),
  ).toBe(true);
  expect(
    isCallerAllowed({
      callerPolicy: 'disabled',
      allowFrom: [LISTED],
      from: LISTED,
    }),
  ).toBe(false);
});

test('allowlist matches regardless of caller-id formatting', () => {
  for (const entry of [LISTED, '4915123456789', '+49 151 234 567-89']) {
    expect(
      isCallerAllowed({
        callerPolicy: 'allowlist',
        allowFrom: [entry],
        // Vonage delivers the E.164 digits without a leading '+'.
        from: '4915123456789',
      }),
    ).toBe(true);
  }
});

test('allowlist rejects unlisted callers', () => {
  expect(
    isCallerAllowed({
      callerPolicy: 'allowlist',
      allowFrom: [LISTED],
      from: '4930000000000',
    }),
  ).toBe(false);
});

test('a wildcard entry accepts any caller', () => {
  expect(
    isCallerAllowed({
      callerPolicy: 'allowlist',
      allowFrom: ['*'],
      from: '4930000000000',
    }),
  ).toBe(true);
});

test('a withheld number never satisfies an allowlist', () => {
  for (const from of ['', undefined, null, 'anonymous']) {
    expect(
      isCallerAllowed({
        callerPolicy: 'allowlist',
        allowFrom: [LISTED],
        from,
      }),
    ).toBe(false);
  }
});

test('normalizeCallerIdentity yields a canonical +digits form', () => {
  expect(normalizeCallerIdentity('+49 151 234 567-89')).toBe(LISTED);
  expect(normalizeCallerIdentity('4915123456789')).toBe(LISTED);
  expect(normalizeCallerIdentity('   ')).toBeNull();
  expect(normalizeCallerIdentity('anonymous')).toBeNull();
});

test('normalizeCallerAllowList dedupes, canonicalizes, and keeps the wildcard', () => {
  expect(
    normalizeCallerAllowList([LISTED, '4915123456789', ' ', 'nope', '*']),
  ).toEqual([LISTED, '*']);
});

test('isCallerPolicy guards the three supported policies', () => {
  expect(['open', 'allowlist', 'disabled'].every(isCallerPolicy)).toBe(true);
  expect(isCallerPolicy('everyone')).toBe(false);
});
