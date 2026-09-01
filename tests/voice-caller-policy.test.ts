import { expect, test } from 'vitest';

import {
  findNationalFormatAllowEntries,
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

test('an unset or unrecognised policy stays on the open default', () => {
  // Config that predates the setting, or any snapshot that skipped
  // normalization, must not silently refuse every caller.
  for (const callerPolicy of [undefined, null, '' as never, 'nonsense' as never]) {
    expect(
      isCallerAllowed({ callerPolicy, allowFrom: undefined, from: CALLER }),
    ).toBe(true);
    expect(pluginPolicy.isCallerAllowed({ callerPolicy, from: CALLER })).toBe(
      true,
    );
  }
});

test('allowlist with a missing list refuses rather than throwing', () => {
  expect(
    isCallerAllowed({
      callerPolicy: 'allowlist',
      allowFrom: undefined,
      from: CALLER,
    }),
  ).toBe(false);
  expect(normalizeCallerAllowList(undefined)).toEqual([]);
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

test('national-format allowlist entries are flagged, valid ones are not', () => {
  expect(
    findNationalFormatAllowEntries([
      '0171-9727750',
      '015123456789',
      LISTED,
      '49 151 234 567-89',
      '*',
      '',
    ]),
  ).toEqual(['0171-9727750', '015123456789']);
});

test('a national-format entry genuinely fails to match, justifying the warning', () => {
  expect(
    isCallerAllowed({
      callerPolicy: 'allowlist',
      allowFrom: ['0171-9727750'],
      from: '491719727750',
    }),
  ).toBe(false);
  expect(
    isCallerAllowed({
      callerPolicy: 'allowlist',
      allowFrom: ['+491719727750'],
      from: '491719727750',
    }),
  ).toBe(true);
});
