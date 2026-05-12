import { afterEach, expect, test, vi } from 'vitest';

import {
  redactCredentialSecrets,
  redactHighEntropyStrings,
  redactSecrets,
  redactSecretsDeep,
} from '../src/security/redact.js';

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
      input: 'token gho_1234567890abcdefghijklmnop',
      expected: 'token gho_12...mnop',
      negative: 'token ghx_1234567890abcdefghijklmnop',
    },
    {
      input: 'token ghs_1234567890abcdefghijklmnop',
      expected: 'token ghs_12...mnop',
      negative: 'token ghs_short',
    },
    {
      input: 'token ghu_1234567890abcdefghijklmnop',
      expected: 'token ghu_12...mnop',
      negative: 'token ghu_short',
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
      input: 'token npm_1234567890abcdefghijklmnop',
      expected: 'token npm_12...mnop',
      negative: 'token npm_short',
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

test('redacts pii while preserving the GitHub noreply allowlist', () => {
  expect(redactSecrets('Contact user@company.com for help')).toBe(
    'Contact ***EMAIL_REDACTED*** for help',
  );
  expect(redactSecrets('From noreply@github.com')).toBe(
    'From noreply@github.com',
  );
  expect(redactSecrets('test@example.com')).toBe('***EMAIL_REDACTED***');
  expect(redactSecrets('Server is at 203.0.113.42 running')).toBe(
    'Server is at ***IP_ADDRESS_REDACTED*** running',
  );
  expect(redactSecrets('Listening on 127.0.0.1 port 8080')).toBe(
    'Listening on 127.0.0.1 port 8080',
  );
  expect(
    redactSecrets('address is 2001:0db8:85a3:0000:0000:8a2e:0370:7334 ok'),
  ).toBe('address is ***IP_ADDRESS_REDACTED*** ok');
  expect(redactSecrets('SSN: 123-45-6789')).toBe('SSN: ***SSN_REDACTED***');
  expect(redactSecrets('SSN: 000-12-3456')).toBe('SSN: 000-12-3456');
  expect(redactSecrets('Call (555) 123-4567 for info')).toBe(
    'Call ***PHONE_REDACTED*** for info',
  );
  expect(redactSecrets('Call +49 170 3330160 for info')).toBe(
    'Call ***PHONE_REDACTED*** for info',
  );
  expect(redactSecrets('Office 089/4233232 is open')).toBe(
    'Office ***PHONE_REDACTED*** is open',
  );
  expect(redactSecrets('Office 089 4233232 is open')).toBe(
    'Office ***PHONE_REDACTED*** is open',
  );
  expect(redactSecrets('Date 2026-03-30 remains visible')).toBe(
    'Date 2026-03-30 remains visible',
  );
  expect(redactSecrets('Card: 4111 1111 1111 1111')).toBe(
    'Card: ***CREDIT_CARD_REDACTED***',
  );
  expect(redactSecrets('Number: 1234567890123456')).toBe(
    'Number: 1234567890123456',
  );
});

test('redacts credential secrets without masking user-visible contact details', () => {
  expect(
    redactCredentialSecrets(
      'Invite user@example.com with OPENAI_API_KEY=sk-1234567890abcdefghijklmnop',
    ),
  ).toBe('Invite user@example.com with OPENAI_API_KEY=sk-123...mnop');
  expect(redactCredentialSecrets('Call +49 170 3330160')).toBe(
    'Call +49 170 3330160',
  );
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

test('redacts high-entropy random-looking strings without touching stable ids', () => {
  expect(
    redactHighEntropyStrings(
      'token Xk9mZr3pWq7vNt2sLf6yBh4jCe8gAa5d should be removed',
    ),
  ).toBe('token ***HIGH_ENTROPY_SECRET_REDACTED*** should be removed');
  expect(
    redactHighEntropyStrings(
      'uuid 550e8400-e29b-41d4-a716-446655440000 should stay',
    ),
  ).toBe('uuid 550e8400-e29b-41d4-a716-446655440000 should stay');
  expect(
    redactHighEntropyStrings(
      'hash a3f5b9c7d1e2f4a6b8c0d2e4f6a8c0e2 should stay',
    ),
  ).toBe('hash a3f5b9c7d1e2f4a6b8c0d2e4f6a8c0e2 should stay');
});
