import { describe, expect, test } from 'vitest';

import {
  AGENT_IDENTITY_COMPONENT_MAX_LENGTH,
  slugifyAgentIdentityComponent,
} from '../src/identity/agent-id.js';

describe('agent identity slug normalization', () => {
  test.each([
    ['', 'fallback'],
    [' ._-! ', 'fallback'],
    [' ._-Research.Agent_1--! ', 'research.agent_1'],
    [' Research / Agent! ', 'research-agent'],
    [' User@Example.com@extra ', 'user'],
    ['@example.com', 'fallback'],
    ['a--._b', 'a--._b'],
    ['a@b\nc', 'a-b-c'],
    ['a@b\nc@d', 'a-b-c'],
    ['a@b\rc@d', 'a-b-c'],
    ['a@b\r\nc@d', 'a-b-c'],
    ['a@b\u2028c@d', 'a-b-c'],
    ['a@b\u2029c@d', 'a-b-c'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(slugifyAgentIdentityComponent(input, 'fallback')).toBe(expected);
  });

  test('trims before truncating while preserving punctuation at the length limit', () => {
    const prefix = 'a'.repeat(AGENT_IDENTITY_COMPONENT_MAX_LENGTH - 1);
    expect(
      slugifyAgentIdentityComponent(`._-${prefix}-b._-`, 'fallback'),
    ).toBe(`${prefix}-`);
    expect(
      slugifyAgentIdentityComponent(`._-${prefix}._-`, 'fallback'),
    ).toBe(prefix);
  });

  test.each([
    [
      'hyphens before a final letter',
      `a${'-'.repeat(100_000)}b`,
      `a${'-'.repeat(AGENT_IDENTITY_COMPONENT_MAX_LENGTH - 1)}`,
    ],
    ['leading punctuation', `${'._-'.repeat(100_000)}agent`, 'agent'],
    ['trailing punctuation', `agent${'._-'.repeat(100_000)}`, 'agent'],
    ['only punctuation', '._-'.repeat(100_000), 'fallback'],
    ['at signs before a newline', `${'@'.repeat(100_000)}\nagent`, 'agent'],
    ['at signs on the final line', `agent${'@'.repeat(100_000)}`, 'agent'],
  ])(
    'handles long input with %s without excessive matching time',
    (_label, input, expected) => {
      const started = performance.now();
      expect(slugifyAgentIdentityComponent(input, 'fallback')).toBe(expected);
      expect(performance.now() - started).toBeLessThan(1_000);
    },
  );
});
