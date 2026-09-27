import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { TrustedAgentApprovalRuntime } from '../container/src/approval-policy.js';
import { matchesPathPattern } from '../container/src/pinned-paths.js';
import { useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-pinned-paths-');

describe('matchesPathPattern', () => {
  test.each([
    { pattern: 'keys/id_?sa', candidate: 'keys/id_rsa', matches: true },
    { pattern: 'keys/id_?sa', candidate: '/workspace/keys/id_dsa', matches: true },
    { pattern: 'keys/id_?sa', candidate: 'keys/idsa', matches: false },
    { pattern: 'keys/id_?sa', candidate: 'keys/id_sa', matches: false },
    { pattern: '?foo', candidate: 'xfoo', matches: true },
    { pattern: '?foo', candidate: 'nested/dir/xfoo', matches: true },
    { pattern: '?foo', candidate: 'notes.txt', matches: false },
    { pattern: '/etc/pass??', candidate: '/etc/passwd', matches: true },
    { pattern: '~/.ssh/id_?sa', candidate: '~/.ssh/id_rsa', matches: true },
    { pattern: '~/.ssh/id_?sa', candidate: '~/.ssh/id_ed25519', matches: false },
    { pattern: '.env*', candidate: 'config/.env.local', matches: true },
    { pattern: '/etc/**', candidate: '/etc', matches: true },
    { pattern: '/etc/**', candidate: '/etc/ssh/sshd_config', matches: true },
    { pattern: '/etc/**', candidate: '/etcetera', matches: false },
    { pattern: 'secrets/**', candidate: 'docs/secrets', matches: false },
    { pattern: 'secrets/*.pem', candidate: 'secrets/a/b.pem', matches: false },
  ])('$pattern vs $candidate: $matches', ({ pattern, candidate, matches }) => {
    expect(matchesPathPattern(candidate, pattern)).toBe(matches);
  });
});

describe('configured pinned_red paths with `?`', () => {
  // `?foo` used to compile to an invalid RegExp, so the pipeline denied every
  // call that carried a path; `keys/id_?sa` did not pin `keys/id_rsa`.
  test.each([
    { tool: 'read', args: { path: 'keys/id_rsa' }, pinned: true, decision: 'required' },
    { tool: 'bash', args: { command: 'cat keys/id_rsa' }, pinned: true, decision: 'required' },
    { tool: 'read', args: { path: 'xfoo' }, pinned: true, decision: 'required' },
    { tool: 'read', args: { path: 'notes.txt' }, pinned: false, decision: 'auto' },
    { tool: 'bash', args: { command: 'cat notes.txt' }, pinned: false, decision: 'auto' },
  ])('$tool $args', ({ tool, args, pinned, decision }) => {
    const dir = makeTempDir();
    const policyPath = path.join(dir, 'policy.yaml');
    fs.writeFileSync(
      policyPath,
      'approval:\n  pinned_red:\n    - paths: ["keys/id_?sa", "?foo"]\n',
    );
    const runtime = new TrustedAgentApprovalRuntime(
      policyPath,
      path.join(dir, 'agent-trust.json'),
      path.join(dir, 'all-trust.json'),
      path.join(dir, 'legacy-trust.json'),
      undefined,
      path.join(dir, 'pending.json'),
    );

    expect(
      runtime.evaluateToolCall({
        toolName: tool,
        argsJson: JSON.stringify(args),
        latestUserPrompt: 'Inspect the files',
      }),
    ).toMatchObject({ pinned, decision });
  });
});
