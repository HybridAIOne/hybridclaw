import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { TrustedAgentApprovalRuntime } from '../container/src/approval-policy.js';
import type { ChatMessage } from '../container/src/types.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-fullauto-approval-');
useCleanMocks({ unstubAllEnvs: true });

function createRuntime(params: {
  fullAuto: boolean;
  neverApproveTools?: string[];
  policy?: string;
}): TrustedAgentApprovalRuntime {
  const dir = makeTempDir();
  const policyPath = path.join(dir, 'policy.yaml');
  if (params.policy) fs.writeFileSync(policyPath, params.policy, 'utf-8');
  const runtime = new TrustedAgentApprovalRuntime(
    policyPath,
    path.join(dir, 'agent-trust.json'),
    path.join(dir, 'all-trust.json'),
    path.join(dir, 'legacy-trust.json'),
    undefined,
    path.join(dir, 'pending.json'),
  );
  runtime.setApprovalMode({
    mode: params.fullAuto ? 'full' : 'auto',
    neverApproveTools: params.neverApproveTools,
  });
  return runtime;
}

function evaluate(
  runtime: TrustedAgentApprovalRuntime,
  toolName: string,
  args: Record<string, unknown>,
) {
  return runtime.evaluateToolCall({
    toolName,
    argsJson: JSON.stringify(args),
    latestUserPrompt: 'Finish the task',
  });
}

function userMessage(content: string): ChatMessage {
  return { role: 'user', content };
}

const PINNED_CALLS: Array<[string, Record<string, unknown>]> = [
  ['read', { path: '.env' }],
  ['write', { path: '.env', contents: 'API_KEY=abc' }],
  ['bash', { command: 'cat config/.env.local' }],
  ['bash', { command: 'cat ~/.ssh/id_rsa' }],
  ['bash', { command: 'cat /etc/passwd' }],
  ['bash', { command: 'grep -r API_KEY .' }],
  ['bash', { command: 'git push --force origin main' }],
  ['bash', { command: 'rm -rf /tmp/build-cache' }],
  ['force_push', { branch: 'main' }],
];

describe('full-auto approvals', () => {
  test.each(PINNED_CALLS)(
    'pinned %s %j prompts with or without full-auto',
    (tool, args) => {
      for (const fullAuto of [false, true]) {
        expect(
          evaluate(createRuntime({ fullAuto }), tool, args),
          `fullAuto=${fullAuto}`,
        ).toMatchObject({
          baseTier: 'red',
          tier: 'red',
          pinned: true,
          decision: 'required',
          requestId: expect.any(String),
        });
      }
    },
  );

  test.each([
    ['read', { path: 'secrets/api.txt' }],
    ['bash', { command: 'terraform destroy -auto-approve' }],
  ])('configured approval.pinned_red %s %j prompts in full-auto', (tool, args) => {
    const runtime = createRuntime({
      fullAuto: true,
      policy: `
approval:
  pinned_red:
    - paths: ["secrets/**"]
    - pattern: 'terraform\\s+destroy'
`,
    });

    expect(evaluate(runtime, tool, args)).toMatchObject({
      pinned: true,
      decision: 'required',
    });
  });

  test('a human approval of a pinned call covers one run only', () => {
    const runtime = createRuntime({ fullAuto: true });
    const args = { path: '.env', contents: 'API_KEY=abc' };

    expect(evaluate(runtime, 'write', args).decision).toBe('required');
    expect(
      runtime.handleApprovalResponse([userMessage('yes for session')])
        ?.approvalMode,
    ).toBe('once');
    expect(evaluate(runtime, 'write', args).decision).toBe('approved_once');
    expect(evaluate(runtime, 'write', args).decision).toBe('required');
  });

  test('unpinned red calls run without a pending prompt', () => {
    const evaluation = evaluate(createRuntime({ fullAuto: true }), 'delete', {
      path: 'notes.txt',
    });

    expect(evaluation).toMatchObject({
      baseTier: 'red',
      tier: 'yellow',
      pinned: false,
      decision: 'approved_fullauto',
    });
    expect(evaluation.requestId).toBeUndefined();
  });

  test('yellow calls run without the implicit delay', () => {
    const evaluation = evaluate(createRuntime({ fullAuto: true }), 'write', {
      path: 'app/ars.R',
      contents: 'test',
    });

    expect(evaluation).toMatchObject({
      baseTier: 'yellow',
      decision: 'approved_fullauto',
    });
    expect(evaluation.implicitDelayMs).toBeUndefined();
  });

  // The suite setup isolates HOME under /tmp, a scratch root that is not
  // fenced; `~/` targets need a home outside the scratch roots.
  const FENCE_WRITES = [
    'echo x > /opt/data/out.txt',
    'echo x > ../out.txt',
    'cp build/app /usr/local/bin/app',
    'curl -o /opt/data/tool https://example.com/tool',
    "echo 'export X=1' >> ~/.bashrc",
  ];

  test.each(FENCE_WRITES)(
    'fence write %s prompts with or without full-auto',
    (command) => {
      vi.stubEnv('HOME', '/home/user_a');
      vi.stubEnv('USERPROFILE', '/home/user_a');

      for (const fullAuto of [false, true]) {
        expect(
          evaluate(createRuntime({ fullAuto }), 'bash', { command }),
          `fullAuto=${fullAuto}`,
        ).toMatchObject({
          actionKey: 'bash:workspace-fence',
          baseTier: 'red',
          tier: 'red',
          pinned: false,
          decision: 'required',
          requestId: expect.any(String),
        });
      }
    },
  );

  test('human-granted trust still covers fence writes in full-auto', () => {
    const runtime = createRuntime({ fullAuto: true });

    expect(
      evaluate(runtime, 'bash', { command: 'echo a > /opt/data/a.txt' })
        .decision,
    ).toBe('required');
    expect(
      runtime.handleApprovalResponse([userMessage('yes for session')])
        ?.approvalMode,
    ).toBe('session');
    expect(
      evaluate(runtime, 'bash', { command: 'echo b > /opt/data/b.txt' }),
    ).toMatchObject({
      actionKey: 'bash:workspace-fence',
      decision: 'approved_session',
    });
  });

  test('scratch writes are not fenced', () => {
    expect(
      evaluate(createRuntime({ fullAuto: true }), 'bash', {
        command: 'echo x > /tmp/out.txt',
      }),
    ).toMatchObject({ actionKey: 'bash:write-op', decision: 'approved_fullauto' });
  });

  test('tools on the never-approve list still prompt', () => {
    const runtime = createRuntime({
      fullAuto: true,
      neverApproveTools: ['delete'],
    });

    expect(evaluate(runtime, 'delete', { path: 'notes.txt' })).toMatchObject({
      baseTier: 'red',
      pinned: false,
      decision: 'required',
      requestId: expect.any(String),
    });
  });
});
