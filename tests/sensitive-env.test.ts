import { expect, test } from 'vitest';

import {
  buildSanitizedEnv,
  isSensitiveEnvName,
} from '../container/shared/sensitive-env.js';

test('buildSanitizedEnv rejects invalid source environments', () => {
  expect(() =>
    buildSanitizedEnv(null as unknown as Record<string, string | undefined>),
  ).toThrow(TypeError);
  expect(() =>
    buildSanitizedEnv(
      undefined as unknown as Record<string, string | undefined>,
    ),
  ).toThrow('buildSanitizedEnv: sourceEnv must be an object');
});

test('buildSanitizedEnv strips exact and pattern-matched credential names', () => {
  const sanitized = buildSanitizedEnv({
    ANTHROPIC_API_KEY: 'anthropic-secret',
    OPENAI_API_KEY: 'openai-secret',
    AWS_REGION: 'us-east-1',
    GITHUB_TOKEN: 'github-secret',
    HYBRIDCLAW_TEST_VISIBLE: 'visible',
  });

  expect(sanitized).toEqual({
    HYBRIDCLAW_TEST_VISIBLE: 'visible',
  });
  expect(isSensitiveEnvName('OPENAI_API_KEY')).toBe(true);
  expect(isSensitiveEnvName('ANTHROPIC_API_KEY')).toBe(true);
});
