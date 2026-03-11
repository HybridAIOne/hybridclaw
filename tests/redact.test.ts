import { afterEach, expect, test, vi } from 'vitest';

import { redactSecrets, redactSecretsDeep } from '../src/security/redact.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

test('redacts known secret token prefixes and leaves non-matches intact', () => {
  const slackToken = ['xoxb', '1234567890', 'abcdefghijklmnop'].join('-');
  const stripeLiveKey = ['sk', 'live', '1234567890abcdefghijklmnop'].join('_');
  const cases = [
    {
      input: 'token sk-1234567890abcdefghijklmnop',
      expected: 'token sk-123...mnop',
      negative: 'token sk-short',
    },
    {
      input: 'token ghp_1234567890abcdefghijklmnop',
      expected: 'token ghp_12...mnop',
      negative: 'token ghx_1234567890abcdefghijklmnop',
    },
    {
      input: 'token github_pat_1234567890abcdefghijklmnop',
      expected: 'token github...mnop',
      negative: 'token github_pat_short',
    },
    {
      input: 'token AKIA1234567890ABCDEF',
      expected: 'token AKIA12...CDEF',
      negative: 'token AKIB1234567890ABCDEF',
    },
    {
      input: `token ${slackToken}`,
      expected: 'token xoxb-1...mnop',
      negative: 'token xoxa-short',
    },
    {
      input: 'token AIza12345678901234567890123456789012345',
      expected: 'token AIza12...2345',
      negative: 'token Aiza12345678901234567890123456789012345',
    },
    {
      input: 'token hf_1234567890abcdefghijklmnop',
      expected: 'token hf_123...mnop',
      negative: 'token hf_short',
    },
    {
      input: `token ${stripeLiveKey}`,
      expected: 'token sk_liv...mnop',
      negative: 'token pk_live_1234567890abcdefghijklmnop',
    },
    {
      input: 'token SG.1234567890abcdefghij.1234567890klmnopqrst',
      expected: 'token SG.123...qrst',
      negative: 'token SG.short.short',
    },
  ] as const;

  for (const { input, expected, negative } of cases) {
    expect(redactSecrets(input)).toBe(expected);
    expect(redactSecrets(negative)).toBe(negative);
  }
});

test('masks bearer tokens and preserves short-token hard redaction', () => {
  expect(redactSecrets('Authorization: Bearer shorttoken')).toBe(
    'Authorization: Bearer ***',
  );
  expect(
    redactSecrets('Authorization: Bearer 1234567890abcdefghijklmnopqrstuv'),
  ).toBe('Authorization: Bearer 123456...stuv');
});

test('redacts env-style assignments and connection strings', () => {
  expect(redactSecrets('OPENAI_API_KEY=sk-1234567890abcdefghijklmnop')).toBe(
    'OPENAI_API_KEY=sk-123...mnop',
  );
  expect(
    redactSecrets('DATABASE_URL=postgres://user:pass@example.com/app'),
  ).toBe('DATABASE_URL=postgres://***');
});

test('redacts secret-looking JSON fields', () => {
  expect(redactSecrets('{"apiKey":"real-secret-value-1234"}')).toBe(
    '{"apiKey":"real-s...1234"}',
  );
  expect(redactSecrets('{"authorization":"Bearer shorttoken"}')).toBe(
    '{"authorization":"Bearer ***"}',
  );
});

test('replaces private keys with a fixed placeholder', () => {
  expect(
    redactSecrets(
      '-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----',
    ),
  ).toBe('***PRIVATE_KEY_REDACTED***');
});

test('passes through ordinary text unchanged', () => {
  const input = 'normal output with no secrets or tokens';
  expect(redactSecrets(input)).toBe(input);
});

test('supports disabling redaction via environment flag', () => {
  vi.stubEnv('HYBRIDCLAW_REDACT_SECRETS', 'false');
  const input = 'OPENAI_API_KEY=sk-1234567890abcdefghijklmnop';
  expect(redactSecrets(input)).toBe(input);
});

test('recursively redacts nested payload values for audit events', () => {
  expect(
    redactSecretsDeep({
      type: 'tool.result',
      nested: {
        apiKey: 'real-secret-value-1234',
      },
      items: ['Bearer shorttoken'],
    }),
  ).toEqual({
    type: 'tool.result',
    nested: {
      apiKey: 'real-s...1234',
    },
    items: ['Bearer ***'],
  });
});
