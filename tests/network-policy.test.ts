import fs from 'node:fs';
import path from 'node:path';

import { expect, test, vi } from 'vitest';
import {
  doesNetworkHostPatternExpandToSubdomains,
  evaluateNetworkPolicyAccess,
  matchesNetworkHostPattern,
  matchesNetworkPathPatterns,
  normalizeNetworkRule,
  readNetworkPolicyState,
} from '../container/shared/network-policy.js';
import {
  loadPolicyFromDisk,
  TrustedAgentApprovalRuntime,
} from '../container/src/approval-policy.js';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir('hybridclaw-network-policy-');
useCleanMocks({ restoreAllMocks: true });

// Reads one policy.yaml rule the way the gateway and the container do.
function decide(
  rule: Record<string, unknown>,
  { defaultAction = 'deny', host = 'evil.example.com', agentId = 'main' } = {},
) {
  const state = readNetworkPolicyState({
    network: { default: defaultAction, rules: [rule] },
  });
  return evaluateNetworkPolicyAccess({
    rules: state.rules,
    defaultAction: state.defaultAction,
    host,
    port: 443,
    method: 'GET',
    path: '/',
    agentId,
  }).decision;
}

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
  { pattern: '*', host: 'a.b.example.org', matches: true },
  { pattern: 'example.*', host: 'example.org', matches: true },
  { pattern: 'example.*', host: 'example.attacker.com', matches: false },
  { pattern: 'example.*', host: 'example.co.uk', matches: false },
  { pattern: 'example.**', host: 'example.co.uk', matches: true },
  { pattern: 'ex*mple.com', host: 'example.com', matches: true },
  { pattern: 'ex*mple.com', host: 'ex.attacker.mple.com', matches: false },
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

test.each([
  { rule: 'example.*', host: 'example.org', decision: 'allow' },
  { rule: 'example.*', host: 'example.attacker.com', decision: 'prompt' },
  { rule: '*.example.com', host: 'a.b.example.com', decision: 'allow' },
  { rule: '*', host: 'a.b.example.org', decision: 'allow' },
])('allow rule $rule under default deny: $host gets $decision', ({
  rule,
  host,
  decision,
}) => {
  expect(
    evaluateNetworkPolicyAccess({
      rules: [
        {
          action: 'allow',
          host: rule,
          port: '*',
          methods: ['*'],
          paths: ['/**'],
          agent: '*',
        },
      ],
      defaultAction: 'deny',
      host,
      port: 443,
      method: 'GET',
      path: '/',
    }).decision,
  ).toBe(decision);
});

test.each([
  { action: 'allow', decision: 'allow' },
  { action: 'deny', decision: 'deny' },
  { action: ' Deny ', decision: 'deny' },
  { action: 'block', decision: 'deny' },
  { action: 'denny', decision: 'deny' },
  { action: 'alow', decision: 'deny' },
  { action: undefined, decision: 'deny' },
])('rule action $action under default deny: $decision', ({
  action,
  decision,
}) => {
  expect(decide({ action, host: 'evil.example.com' })).toBe(decision);
});

test.each([
  {
    name: 'a deny rule with port 99999',
    rule: { action: 'deny', host: 'evil.example.com', port: 99999 },
    host: 'evil.example.com',
    decision: 'deny',
  },
  {
    name: 'a deny rule without a host',
    rule: { action: 'deny' },
    host: 'any.example.org',
    decision: 'deny',
  },
  {
    name: 'a misspelled action key',
    rule: { actoin: 'deny', host: 'evil.example.com' },
    host: 'evil.example.com',
    decision: 'deny',
  },
  {
    name: 'a block rule',
    rule: { action: 'block', host: 'evil.example.com' },
    host: 'other.example.org',
    decision: 'allow',
  },
  {
    name: 'a block rule for another agent',
    rule: { action: 'block', host: 'evil.example.com', agent: 'research' },
    host: 'evil.example.com',
    decision: 'allow',
  },
])('$name under default allow: $host gets $decision', ({
  rule,
  host,
  decision,
}) => {
  expect(decide(rule, { defaultAction: 'allow', host })).toBe(decision);
});

test.each([
  { name: 'action block', rule: { action: 'block', host: 'example.com' } },
  { name: 'no action', rule: { host: 'example.com' } },
  { name: 'no host', rule: { action: 'deny' } },
  {
    name: 'port 99999',
    rule: { action: 'deny', host: 'example.com', port: 99999 },
  },
])('editors reject a rule with $name', ({ rule }) => {
  expect(normalizeNetworkRule(rule)).toBeNull();
});

test('the container denies an unreadable rule and keeps the rest of the policy', () => {
  const policyPath = path.join(makeTempDir(), 'policy.yaml');
  fs.writeFileSync(
    policyPath,
    [
      'approval:',
      '  pinned_red:',
      '    - pattern: "kubectl delete"',
      'network:',
      '  default: deny',
      '  rules:',
      '    - action: block',
      '      host: evil.example.com',
      '',
    ].join('\n'),
  );
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  expect(loadPolicyFromDisk(policyPath)).toMatchObject({
    pinnedRed: [{ pattern: 'kubectl delete' }],
    networkRules: [{ action: 'deny', host: 'evil.example.com', port: '*' }],
  });
  expect(errorSpy).not.toHaveBeenCalled();

  const runtime = new TrustedAgentApprovalRuntime(policyPath);
  const fetchUrl = (url: string) =>
    runtime.evaluateToolCall({
      toolName: 'http_request',
      argsJson: JSON.stringify({ url, method: 'GET' }),
      latestUserPrompt: 'Fetch the page',
    });
  expect(fetchUrl('https://evil.example.com/')).toMatchObject({
    tier: 'red',
    decision: 'denied',
  });
  expect(fetchUrl('https://other.example.org/')).toMatchObject({
    tier: 'yellow',
    decision: 'implicit',
  });
});
