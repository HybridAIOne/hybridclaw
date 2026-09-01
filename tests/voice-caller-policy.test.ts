import { expect, test } from 'vitest';

import {
  isCallerAllowed,
  normalizeCallerAllowList,
  normalizeCallerIdentity,
} from '../src/channels/voice/caller-policy.js';
import * as pluginPolicy from '../plugins/vonage-voice/src/caller-policy.js';

const LISTED = '+4915123456789';
// Carriers deliver E.164 digits without a leading '+'.
const CALLER = '4915123456789';

test('open accepts every caller and disabled rejects every caller', () => {
  expect(
    isCallerAllowed({ callerPolicy: 'open', allowFrom: [], from: CALLER }),
  ).toBe(true);
  expect(
    isCallerAllowed({
      callerPolicy: 'disabled',
      allowFrom: [LISTED],
      from: CALLER,
    }),
  ).toBe(false);
});

test('allowlist matches whatever formatting the entry was written in', () => {
  for (const entry of [LISTED, CALLER, '+49 151 234 567-89']) {
    expect(
      isCallerAllowed({
        callerPolicy: 'allowlist',
        allowFrom: [entry],
        from: CALLER,
      }),
    ).toBe(true);
  }
});

test('allowlist rejects an unlisted caller', () => {
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
  expect(normalizeCallerIdentity(CALLER)).toBe(LISTED);
  expect(normalizeCallerIdentity('   ')).toBeNull();
  expect(normalizeCallerIdentity('anonymous')).toBeNull();
});

test('normalizeCallerAllowList dedupes, canonicalizes, and keeps the wildcard', () => {
  expect(normalizeCallerAllowList([LISTED, CALLER, ' ', 'nope', '*'])).toEqual([
    LISTED,
    '*',
  ]);
});

test('the vonage plugin mirror agrees with the core implementation', () => {
  const cases = [
    { callerPolicy: 'open' as const, allowFrom: [], from: CALLER },
    { callerPolicy: 'disabled' as const, allowFrom: [LISTED], from: CALLER },
    { callerPolicy: 'allowlist' as const, allowFrom: [LISTED], from: CALLER },
    { callerPolicy: 'allowlist' as const, allowFrom: [LISTED], from: '49300' },
    { callerPolicy: 'allowlist' as const, allowFrom: ['*'], from: '49300' },
    { callerPolicy: 'allowlist' as const, allowFrom: [LISTED], from: '' },
  ];
  for (const params of cases) {
    expect(pluginPolicy.isCallerAllowed(params)).toBe(isCallerAllowed(params));
  }
});
