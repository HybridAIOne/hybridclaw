import { expect, test } from 'vitest';
import {
  doesNetworkHostPatternExpandToSubdomains,
  evaluateNetworkPolicyAccess,
  matchesNetworkHostPattern,
  matchesNetworkPathPatterns,
} from '../container/shared/network-policy.js';

test.each([
  { pattern: 'ap?.example.com', host: 'api.example.com', matches: true },
  { pattern: 'ap?.example.com', host: 'ap.example.com', matches: false },
  { pattern: 'ap?.example.com', host: 'x.api.example.com', matches: false },
  { pattern: '*.ap?.example.com', host: 'x.api.example.com', matches: true },
  { pattern: '*.ap?.example.com', host: 'x.ap.example.com', matches: false },
  { pattern: '?*.example.com', host: 'a.example.com', matches: true },
  { pattern: 'ex?mple.com', host: 'example.com', matches: true },
  { pattern: 'ex?mple.com', host: 'api.example.com', matches: false },
  { pattern: 'ex?mple.com', host: 'ex.mple.com', matches: false },
  { pattern: '*.example.com', host: 'a.b.example.com', matches: true },
  { pattern: '*.example.com', host: 'example.com', matches: false },
  { pattern: 'example.com', host: 'api.example.com', matches: true },
  { pattern: '10.0.0.0/8', host: '10.1.2.3', matches: true },
])('host $pattern vs $host: $matches', ({ pattern, host, matches }) => {
  expect(matchesNetworkHostPattern(pattern, host)).toBe(matches);
});

test.each([
  { pattern: 'example.com', expands: true },
  { pattern: 'ex?mple.com', expands: false },
  { pattern: '*.example.com', expands: false },
])('host $pattern covers subdomains: $expands', ({ pattern, expands }) => {
  expect(doesNetworkHostPatternExpandToSubdomains(pattern)).toBe(expands);
});

test.each([
  { pattern: '/v?/items', path: '/v1/items', matches: true },
  { pattern: '/v?/items', path: '/v12/items', matches: false },
  { pattern: '/v?/items', path: '/v/items', matches: false },
  { pattern: '/v?/items', path: '//items', matches: false },
  { pattern: '/???', path: '/abc', matches: true },
  { pattern: '/repos/**', path: '/repos/a/b', matches: true },
  { pattern: '/repos/**', path: '/repos', matches: false },
  { pattern: '/repos/*', path: '/repos/a/b', matches: false },
  { pattern: 'repos/*', path: '/repos/a', matches: true },
])('path $pattern vs $path: $matches', ({ pattern, path, matches }) => {
  expect(matchesNetworkPathPatterns([pattern], path)).toBe(matches);
});

test('a deny rule with `?` blocks the hosts its glob names', () => {
  const rules = [
    {
      action: 'deny' as const,
      host: 'ev?l.example.com',
      port: '*' as const,
      methods: ['*'],
      paths: ['/**'],
      agent: '*',
    },
  ];
  const evaluate = (host: string) =>
    evaluateNetworkPolicyAccess({
      rules,
      defaultAction: 'allow',
      host,
      port: 443,
      method: 'GET',
      path: '/',
    }).decision;

  expect(evaluate('evil.example.com')).toBe('deny');
  expect(evaluate('eval.example.com')).toBe('deny');
  expect(evaluate('example.com')).toBe('allow');
});
