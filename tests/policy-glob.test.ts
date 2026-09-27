import { describe, expect, test } from 'vitest';
import {
  globToRegExp,
  hasGlobWildcard,
} from '../container/shared/policy-glob.js';

const KINDS = ['path', 'host', 'text'] as const;

describe('globToRegExp', () => {
  test.each([
    { kind: 'path', pattern: 'keys/id_?sa', value: 'keys/id_rsa', matches: true },
    { kind: 'path', pattern: 'keys/id_?sa', value: 'keys/idsa', matches: false },
    { kind: 'path', pattern: 'keys/id_?sa', value: 'keys/id_sa', matches: false },
    { kind: 'path', pattern: 'keys/id_?sa', value: 'keys/id_/sa', matches: false },
    { kind: 'path', pattern: '?foo', value: 'xfoo', matches: true },
    { kind: 'path', pattern: '?foo', value: 'foo', matches: false },
    { kind: 'path', pattern: '/???', value: '/abc', matches: true },
    { kind: 'path', pattern: '/???', value: '/ab', matches: false },
    { kind: 'path', pattern: '*.md', value: 'notes.md', matches: true },
    { kind: 'path', pattern: '*.md', value: 'docs/notes.md', matches: false },
    { kind: 'path', pattern: 'docs/**', value: 'docs/a/b.md', matches: true },
    { kind: 'path', pattern: 'docs/**', value: 'docs', matches: false },
    { kind: 'path', pattern: '.ENV*', value: '.env.local', matches: true },
    { kind: 'host', pattern: 'ap?.example.com', value: 'api.example.com', matches: true },
    { kind: 'host', pattern: 'ap?.example.com', value: 'ap.example.com', matches: false },
    { kind: 'host', pattern: 'ex?mple.com', value: 'ex.mple.com', matches: false },
    { kind: 'host', pattern: '?*.example.com', value: 'a.b.example.com', matches: true },
    { kind: 'host', pattern: '*.example.com', value: 'a.b.example.com', matches: true },
    { kind: 'host', pattern: '*.example.com', value: 'example.com', matches: false },
    { kind: 'text', pattern: 'KEY_?', value: 'KEY_1', matches: true },
    { kind: 'text', pattern: 'KEY_?', value: 'KEY_12', matches: false },
    { kind: 'text', pattern: '?_TOKEN', value: 'A_TOKEN', matches: true },
    { kind: 'text', pattern: 'DATEV_*', value: 'datev_password', matches: true },
    { kind: 'text', pattern: '#pass?ord', value: '#password', matches: true },
  ] as const)('$kind glob $pattern vs $value: $matches', ({
    kind,
    pattern,
    value,
    matches,
  }) => {
    expect(globToRegExp(pattern, kind).test(value)).toBe(matches);
  });

  test.each(KINDS)('wildcard runs compile in %s globs', (kind) => {
    for (const pattern of ['?', '??', '???', '?*', '*?', '**?', '?**']) {
      expect(() => globToRegExp(pattern, kind), pattern).not.toThrow();
    }
  });

  test.each(KINDS)('every other printable character is literal in %s globs', (kind) => {
    for (let code = 0x20; code <= 0x7e; code += 1) {
      const char = String.fromCharCode(code);
      if (char === '*' || char === '?') continue;
      const literal = `a${char}b`;
      const regexp = globToRegExp(literal, kind);
      for (const value of [literal, 'ab', 'a~b', `a${char}${char}b`, 'a.b']) {
        expect(regexp.test(value), `${literal} vs ${value}`).toBe(
          value.toLowerCase() === literal.toLowerCase(),
        );
      }
    }
  });

  test('rejects an unknown kind', () => {
    expect(() => globToRegExp('a', 'shell' as never)).toThrow(
      'Unknown policy glob kind: shell',
    );
  });
});

test.each([
  { pattern: '*.example.com', wildcard: true },
  { pattern: 'ex?mple.com', wildcard: true },
  { pattern: 'example.com', wildcard: false },
])('hasGlobWildcard($pattern) is $wildcard', ({ pattern, wildcard }) => {
  expect(hasGlobWildcard(pattern)).toBe(wildcard);
});
