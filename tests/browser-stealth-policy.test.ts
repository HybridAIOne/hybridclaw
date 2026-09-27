import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';

import {
  loadPolicyFromDisk,
  TrustedAgentApprovalRuntime,
} from '../container/src/approval-policy.js';
import {
  assertBrowserStealthAllowed,
  evaluateBrowserStealthPolicyAccess,
  readBrowserStealthPolicyStateFromDocument,
} from '../src/security/browser-stealth-policy.js';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeWorkspace = useTempDir('hybridclaw-stealth-policy-');
useCleanMocks({ unstubAllEnvs: true });

function writePolicy(workspacePath: string, raw: string): string {
  const policyPath = path.join(workspacePath, '.hybridclaw', 'policy.yaml');
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  fs.writeFileSync(policyPath, `${raw.trim()}\n`, 'utf-8');
  return policyPath;
}

const allowEveryHost = {
  action: 'allow',
  when: { predicate: 'browser_stealth_allowed', host: '*' },
};

function decide(rules: unknown[], context: Record<string, string> = {}) {
  return evaluateBrowserStealthPolicyAccess({
    state: readBrowserStealthPolicyStateFromDocument({
      browser: { stealth: { rules } },
    }),
    context: { host: 'login.example.com', ...context },
  });
}

test('browser stealth policy defaults to deny', () => {
  const state = readBrowserStealthPolicyStateFromDocument({});

  const evaluation = evaluateBrowserStealthPolicyAccess({
    state,
    context: { host: 'login.example.com' },
  });

  expect(evaluation.decision).toBe('deny');
});

test('browser_stealth_allowed matches site-scoped hosts', () => {
  const state = readBrowserStealthPolicyStateFromDocument({
    browser: {
      stealth: {
        rules: [
          {
            action: 'allow',
            when: {
              predicate: 'browser_stealth_allowed',
              host: 'example.com',
            },
          },
        ],
      },
    },
  });

  const allowed = evaluateBrowserStealthPolicyAccess({
    state,
    context: { host: 'login.example.com' },
  });
  const denied = evaluateBrowserStealthPolicyAccess({
    state,
    context: { host: 'other.example.net' },
  });

  expect(allowed.decision).toBe('allow');
  expect(denied.decision).toBe('deny');
});

test('workspace browser stealth assertion reads policy.yaml', () => {
  const workspacePath = makeWorkspace();
  writePolicy(
    workspacePath,
    `
browser:
  stealth:
    rules:
      - action: allow
        when:
          predicate: browser_stealth_allowed
          host: example.com
`,
  );

  expect(() =>
    assertBrowserStealthAllowed({
      workspacePath,
      context: { host: 'login.example.com' },
    }),
  ).not.toThrow();
  expect(() =>
    assertBrowserStealthAllowed({
      workspacePath,
      context: { host: 'blocked.example.net' },
    }),
  ).toThrow(/not allowlisted/u);
});

test.each([
  { name: 'the named skill', context: { skillName: 'login' }, decision: 'allow' },
  { name: 'another skill', context: { skillName: 'scraper' }, decision: 'deny' },
  {
    name: 'another agent',
    context: { skillName: 'login', agentId: 'research' },
    decision: 'deny',
  },
])('an allow rule scoped to a skill and agent decides $decision for $name', ({
  context,
  decision,
}) => {
  const rule = {
    action: 'allow',
    comment: 'login flow only',
    when: {
      predicate: 'browser_stealth_allowed',
      host: 'example.com',
      skillName: ['login'],
      agentId: 'main',
    },
  };

  expect(decide([rule], { agentId: 'main', ...context }).decision).toBe(
    decision,
  );
});

test.each([
  {
    name: 'a misspelled parameter',
    when: {
      predicate: 'browser_stealth_allowed',
      host: 'example.com',
      skilName: 'login',
    },
    problem: '"skilName"',
  },
  {
    name: 'no host',
    when: { predicate: 'browser_stealth_allowed', skillName: 'login' },
    problem: 'parameter host',
  },
  {
    name: 'a host list',
    when: { predicate: 'browser_stealth_allowed', host: ['example.com'] },
    problem: 'when.host',
  },
  {
    name: 'an inherited predicate name',
    when: { predicate: 'toString' },
    problem: '"toString"',
  },
  { name: 'a string when', when: 'always', problem: '"always"' },
  { name: 'an empty any list', when: { any: [] }, problem: 'when.any' },
])('a stealth rule with $name denies every host and says why', ({
  when,
  problem,
}) => {
  const evaluation = decide([{ action: 'allow', when }, allowEveryHost], {
    skillName: 'scraper',
  });

  expect(evaluation.decision).toBe('deny');
  expect(evaluation.matchedRule?.description).toMatch(
    /^Unreadable browser stealth rule #1\b/,
  );
  expect(evaluation.matchedRule?.description).toContain(problem);
});

test('a stealth rule with an unknown action denies only the hosts it names', () => {
  const rules = [
    {
      action: 'dney',
      when: { predicate: 'browser_stealth_allowed', host: 'evil.test' },
    },
    allowEveryHost,
  ];

  expect(decide(rules, { host: 'www.evil.test' }).decision).toBe('deny');
  expect(decide(rules).decision).toBe('allow');
});

test('workspace browser stealth assertion refuses an unreadable allow rule', () => {
  const workspacePath = makeWorkspace();
  writePolicy(
    workspacePath,
    `
browser:
  stealth:
    rules:
      - action: allow
        when:
          predicate: browser_stealth_allowed
          host: example.com
          skilName: login
`,
  );

  expect(() =>
    assertBrowserStealthAllowed({
      workspacePath,
      context: { host: 'login.example.com', skillName: 'scraper' },
    }),
  ).toThrow(/not allowlisted/u);
});

test('the container keeps its approval policy and hard-denies stealth when a stealth rule is unreadable', () => {
  vi.stubEnv('HYBRIDCLAW_BROWSER_PROVIDER', 'camofox');
  const policyPath = writePolicy(
    makeWorkspace(),
    `
approval:
  pinned_red:
    - pattern: custom-pinned-marker
browser:
  stealth:
    rules:
      - action: allow
        when: &loop
          not: *loop
      - action: allow
        when:
          predicate: browser_stealth_allowed
          host: example.com
`,
  );

  expect(loadPolicyFromDisk(policyPath).pinnedRed).toEqual([
    { pattern: 'custom-pinned-marker' },
  ]);
  expect(
    new TrustedAgentApprovalRuntime(policyPath).evaluateToolCall({
      toolName: 'browser_navigate',
      argsJson: JSON.stringify({ url: 'https://login.example.com/' }),
      latestUserPrompt: 'Open the login page',
    }),
  ).toMatchObject({
    decision: 'denied',
    reason: expect.stringMatching(/^Unreadable browser stealth rule #1\b/),
  });
});
