import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { TrustedAgentApprovalRuntime } from '../container/src/approval-policy.js';
import type { ChatMessage } from '../container/src/types.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-self-edit-');
useCleanMocks({ unstubAllEnvs: true, resetModules: true });

function createRuntime(fullAuto: boolean): TrustedAgentApprovalRuntime {
  const dir = makeTempDir();
  const runtime = new TrustedAgentApprovalRuntime(
    path.join(dir, 'missing-policy.yaml'),
    path.join(dir, 'agent-trust.json'),
    path.join(dir, 'all-trust.json'),
    path.join(dir, 'legacy-trust.json'),
    undefined,
    path.join(dir, 'pending.json'),
  );
  runtime.setApprovalMode({ mode: fullAuto ? 'full' : 'auto' });
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
    latestUserPrompt: 'Tidy up the workspace',
  });
}

function userMessage(content: string): ChatMessage {
  return { role: 'user', content };
}

const POLICY = '.hybridclaw/policy.yaml';

describe('agent changes to its own approval policy and trust files', () => {
  test.each([
    ['write', { path: POLICY, contents: 'network:\n  default: allow\n' }],
    ['write', { path: `/workspace/${POLICY}`, contents: 'x' }],
    ['write', { path: `notes/../${POLICY}`, contents: 'x' }],
    ['edit', { path: POLICY, old: 'deny', new: 'allow' }],
    ['write', { path: '.hybridclaw/approval-agent-trust.json', contents: '{}' }],
    ['write', { path: '.hybridclaw/pending-approvals.json', contents: '{}' }],
    ['write', { path: 'approval-trust.json', contents: '{}' }],
    [
      'write',
      { path: '.hybridclaw-runtime/sessions/a1/fetched-files.json', contents: '{}' },
    ],
    ['delete', { path: POLICY }],
    ['bash', { command: `echo 'default: allow' > ${POLICY}` }],
    ['bash', { command: `sed -i 's/deny/allow/' ${POLICY}` }],
    ['bash', { command: 'cp /tmp/policy.yaml .hybridclaw/' }],
    ['bash', { command: 'cd .hybridclaw && echo x > policy.yaml' }],
    ['bash', { command: 'mv .hybridclaw .hybridclaw.bak' }],
    ['bash', { command: 'rm approval-trust.json' }],
    ['bash', { command: `git checkout -- ${POLICY}` }],
  ])('%s %j waits for a human, full-auto included', (toolName, args) => {
    for (const fullAuto of [false, true]) {
      expect(
        evaluate(createRuntime(fullAuto), toolName, args),
        `fullAuto=${fullAuto}`,
      ).toMatchObject({
        actionKey: `approval-state:${toolName}`,
        tier: 'red',
        decision: 'required',
        pinned: true,
      });
    }
  });

  test.each([
    ['read', { path: POLICY }],
    ['grep', { pattern: 'allow', path: '.hybridclaw' }],
    ['bash', { command: "grep -r --exclude='.env*' needle ." }],
    ['write', { path: 'project/.hybridclaw/policy.yaml', contents: 'x' }],
    ['write', { path: '.hybridclaw-runtime/home/.npmrc', contents: 'x' }],
  ])('%s %j keeps its usual tier', (toolName, args) => {
    const evaluation = evaluate(createRuntime(true), toolName, args);

    expect(evaluation.actionKey).not.toMatch(/^approval-state:/);
    expect(evaluation.pinned).toBe(false);
  });

  test('a human approval covers one change and never becomes durable trust', () => {
    const runtime = createRuntime(true);
    const change = { path: POLICY, contents: 'x' };
    expect(evaluate(runtime, 'write', change).decision).toBe('required');

    runtime.handleApprovalResponse([userMessage('yes for agent')]);

    expect(evaluate(runtime, 'write', change).decision).toBe('approved_once');
    expect(evaluate(runtime, 'write', change).decision).toBe('required');
  });
});

test('host-absolute paths to the approval state wait for a human', async () => {
  const workspace = makeTempDir();
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspace);
  vi.resetModules();
  const { TrustedAgentApprovalRuntime: WorkspaceRuntime } = await import(
    '../container/src/approval-policy.js'
  );
  const runtime = new WorkspaceRuntime(
    path.join(workspace, 'missing-policy.yaml'),
  );
  runtime.setApprovalMode({ mode: 'full' });
  const policyPath = path.join(workspace, POLICY);

  for (const [toolName, args] of [
    ['write', { path: policyPath, contents: 'x' }],
    ['bash', { command: `echo x > ${policyPath}` }],
  ] as const) {
    expect(evaluate(runtime, toolName, args), toolName).toMatchObject({
      actionKey: `approval-state:${toolName}`,
      decision: 'required',
      pinned: true,
    });
  }
});

test('every file the approval runtime persists is protected approval state', async () => {
  const workspace = makeTempDir();
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspace);
  vi.resetModules();
  const { TrustedAgentApprovalRuntime: WorkspaceRuntime } = await import(
    '../container/src/approval-policy.js'
  );
  const { matchesApprovalStatePath } = await import(
    '../container/src/approval-state-guard.js'
  );
  fs.mkdirSync(path.join(workspace, '.hybridclaw'));
  fs.writeFileSync(path.join(workspace, POLICY), 'approval: {}\n');
  const runtime = new WorkspaceRuntime();
  runtime.setSession('session-a');
  const evaluateBash = (command: string) =>
    runtime.evaluateToolCall({
      toolName: 'bash',
      argsJson: JSON.stringify({ command }),
      latestUserPrompt: 'Install the tool',
    });

  evaluateBash('curl -o /tmp/tool.sh https://get.example.com/tool.sh');
  evaluateBash('sudo reboot');
  runtime.handleApprovalResponse([userMessage('yes for agent')]);
  evaluateBash('bash ./deploy.sh');
  runtime.handleApprovalResponse([userMessage('yes for all')]);

  const persisted = fs
    .readdirSync(workspace, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(workspace, path.join(entry.parentPath, entry.name)),
    );
  expect(persisted.length).toBeGreaterThanOrEqual(5);
  for (const file of persisted) {
    expect(matchesApprovalStatePath(file), file).toBe(true);
  }
});
