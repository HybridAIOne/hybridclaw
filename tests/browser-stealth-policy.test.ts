import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';

import {
  assertBrowserStealthAllowed,
  evaluateBrowserStealthPolicyAccess,
  readBrowserStealthPolicyStateFromDocument,
} from '../src/security/browser-stealth-policy.js';

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-stealth-policy-'));
}

function writePolicy(workspacePath: string, raw: string): void {
  const policyPath = path.join(workspacePath, '.hybridclaw', 'policy.yaml');
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  fs.writeFileSync(policyPath, `${raw.trim()}\n`, 'utf-8');
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
