import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  describeApprovalAction,
  grantApprovalTrust,
  parseApprovalTrustStore,
  revokeApprovalTrust,
} from '../container/shared/approval-rules.js';
import { TrustedAgentApprovalRuntime } from '../container/src/approval-policy.js';
import { buildPendingApproval } from '../container/src/tool-approval.js';
import { parseApprovalProgress } from '../src/infra/approval-progress.js';
import {
  listApprovalRules,
  revokeApprovalRule,
} from '../src/gateway/approval-rules-command.js';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir('hybridclaw-approval-rules-');

useCleanMocks({
  restoreAllMocks: true,
  unstubAllEnvs: true,
  resetModules: true,
});

const DELETE_CALL = {
  toolName: 'bash',
  argsJson: JSON.stringify({ command: 'rm notes/old.txt' }),
  latestUserPrompt: 'Clean up the old notes',
};

// A runtime whose grant stores sit where the gateway looks for them.
function workspaceRuntime(workspace: string): TrustedAgentApprovalRuntime {
  return new TrustedAgentApprovalRuntime(
    path.join(workspace, '.hybridclaw', 'policy.yaml'),
    path.join(workspace, '.hybridclaw', 'approval-agent-trust.json'),
    path.join(workspace, 'approval-trust.json'),
    path.join(workspace, '.hybridclaw', 'approval-trust.json'),
    undefined,
    path.join(workspace, '.hybridclaw', 'pending-approvals.json'),
  );
}

describe('describeApprovalAction', () => {
  test.each([
    ['bash:delete', 'delete_files', undefined],
    ['delete:notes', 'delete_files', 'notes'],
    ['write:root', 'change_files', undefined],
    ['bash:other', 'run_commands', undefined],
    ['bash:install-deps', 'install_packages', undefined],
    ['bash:network:api.example.com', 'web_requests', 'api.example.com'],
    ['network:api.example.com:GET', 'web_requests', 'api.example.com'],
    ['network:api.example.com:443:POST:/v1', 'send_to_websites', 'api.example.com:443'],
    ['network:web-search', 'web_search', undefined],
    ['message:send:pat@example.com', 'send_messages', 'pat@example.com'],
    ['message:send:current', 'send_messages', undefined],
    ['mcp:mail:send:send_email', 'connector', 'send_email'],
    ['image_generate', 'tool', 'image_generate'],
  ])('%s → %s', (actionKey, category, target) => {
    const described = describeApprovalAction(actionKey);
    expect(described.category).toBe(category);
    expect(described.target).toBe(target);
    expect(described.label).toBeTruthy();
  });
});

describe('approval trust store', () => {
  test('revoking a key drops its fingerprints and grants from before grants were kept', () => {
    const legacy = parseApprovalTrustStore(
      JSON.stringify({
        version: 2,
        allowlistedActions: ['bash:other'],
        allowlistedFingerprints: ['aaaa000011112222'],
      }),
    );
    expect(legacy).not.toBeNull();
    const granted = grantApprovalTrust(legacy!, {
      actionKey: 'bash:delete',
      fingerprint: 'bbbb000011112222',
      intent: 'delete `notes/old.txt`',
      toolName: 'bash',
    });
    expect(granted.grants).toHaveLength(1);

    const { store, revoked } = revokeApprovalTrust(granted, 'bash:delete');
    expect(revoked).toBe(true);
    expect(store.actions).toEqual(['bash:other']);
    expect(store.fingerprints).toEqual([]);
    expect(revokeApprovalTrust(store, 'bash:delete').revoked).toBe(false);
  });
});

describe('always allow', () => {
  test('the approval names the rule that paused it and what always allowing covers', () => {
    const runtime = workspaceRuntime(makeTempDir());
    runtime.setApprovalMode({ mode: 'auto' });
    const evaluation = runtime.evaluateToolCall(DELETE_CALL);
    expect(evaluation.decision).toBe('required');
    expect(evaluation.pausedBy).toBe('risky');

    const pending = buildPendingApproval(
      evaluation,
      'prompt',
      DELETE_CALL.toolName,
      DELETE_CALL.argsJson,
    );
    expect(pending.rule).toMatchObject({
      actionKey: 'bash:delete',
      category: 'delete_files',
      pausedBy: 'risky',
    });
    expect(pending.allowAgent).toBe(true);

    // The gateway reads the same rule back from the worker's progress line.
    const line = `[approval] ${Buffer.from(JSON.stringify(pending)).toString('base64')}`;
    expect(parseApprovalProgress(line)?.rule).toEqual(pending.rule);
  });

  test('ask mode and pinned paths name their own rule', () => {
    const runtime = workspaceRuntime(makeTempDir());
    runtime.setApprovalMode({ mode: 'ask' });
    const asked = runtime.evaluateToolCall({
      toolName: 'write',
      argsJson: JSON.stringify({ path: 'notes/today.md', content: 'hi' }),
      latestUserPrompt: 'Write today’s notes',
    });
    expect(asked.decision).toBe('required');
    expect(asked.pausedBy).toBe('ask_mode');

    const pinned = runtime.evaluateToolCall({
      toolName: 'write',
      argsJson: JSON.stringify({ path: '.env', content: 'X=1' }),
      latestUserPrompt: 'Set X',
    });
    expect(pinned.decision).toBe('required');
    expect(pinned.pausedBy).toBe('protected');
    expect(
      buildPendingApproval(pinned, 'prompt', 'write', '{}').allowAgent,
    ).toBe(false);
  });

  test('a rule revoked by the gateway asks again in the running worker', () => {
    const workspace = makeTempDir();
    const runtime = workspaceRuntime(workspace);
    const first = runtime.evaluateToolCall(DELETE_CALL);
    expect(first.decision).toBe('required');
    runtime.handleApprovalResponse([
      { role: 'user', content: `yes ${first.requestId} for agent` },
    ]);
    expect(runtime.evaluateToolCall(DELETE_CALL).decision).toBe(
      'approved_agent',
    );

    const rules = listApprovalRules(workspace);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      actionKey: 'bash:delete',
      scope: 'agent',
      category: 'delete_files',
    });
    expect(rules[0].intent).toContain('notes/old.txt');
    expect(rules[0].grantedAt).toBeTruthy();

    expect(revokeApprovalRule(workspace, 'bash:delete')).toEqual(['agent']);
    expect(listApprovalRules(workspace)).toEqual([]);
    expect(runtime.evaluateToolCall(DELETE_CALL).decision).toBe('required');
  });

  test('a grant made after a revoke does not bring the revoked rule back', () => {
    const workspace = makeTempDir();
    const runtime = workspaceRuntime(workspace);
    const deleting = runtime.evaluateToolCall(DELETE_CALL);
    runtime.handleApprovalResponse([
      { role: 'user', content: `yes ${deleting.requestId} for agent` },
    ]);
    revokeApprovalRule(workspace, 'bash:delete');

    const fencing = runtime.evaluateToolCall({
      toolName: 'bash',
      argsJson: JSON.stringify({ command: 'touch /Users/example/report.txt' }),
      latestUserPrompt: 'Write the report to a host file',
    });
    expect(fencing.decision).toBe('required');
    runtime.handleApprovalResponse([
      { role: 'user', content: `yes ${fencing.requestId} for agent` },
    ]);
    expect(listApprovalRules(workspace).map((rule) => rule.actionKey)).toEqual(
      [fencing.actionKey],
    );
  });
});

describe('/approvals rules', () => {
  async function setup(sessionId: string) {
    vi.stubEnv('HOME', makeTempDir());
    vi.resetModules();
    const db = await import('../src/memory/db.ts');
    const { memoryService } = await import('../src/memory/memory-service.ts');
    const gateway = await import('../src/gateway/gateway-service.ts');
    const { agentWorkspaceDir } = await import('../src/infra/ipc.ts');
    db.initDatabase({ quiet: true });
    const session = memoryService.getOrCreateSession(sessionId, null, 'web');
    const workspace = agentWorkspaceDir(session.agent_id || 'main');
    const run = (...args: string[]) =>
      gateway.handleGatewayCommand({
        sessionId,
        guildId: null,
        channelId: 'web',
        userId: 'user_a',
        args: ['approvals', 'rules', ...args],
      });
    return { workspace, run };
  }

  test('lists and revokes rules as JSON', async () => {
    const { workspace, run } = await setup('s-rules');
    fs.mkdirSync(path.join(workspace, '.hybridclaw'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.hybridclaw', 'approval-agent-trust.json'),
      JSON.stringify({
        version: 2,
        allowlistedActions: ['bash:delete', 'network:api.example.com:GET'],
        allowlistedFingerprints: [],
      }),
    );

    const listed = JSON.parse((await run('--json')).text);
    expect(listed.version).toBe(1);
    expect(listed.rules.map((rule: { category: string }) => rule.category))
      .toEqual(['delete_files', 'web_requests']);

    const revoked = JSON.parse((await run('revoke', '1', '--json')).text);
    expect(revoked.revoked).toBe(true);
    expect(revoked.rules).toHaveLength(1);
    expect(revoked.rules[0].actionKey).toBe('network:api.example.com:GET');

    const again = JSON.parse(
      (await run('revoke', 'bash:delete', '--json')).text,
    );
    expect(again.revoked).toBe(false);
  });

  test('an empty workspace has no rules', async () => {
    const { run } = await setup('s-empty');
    expect(JSON.parse((await run('--json')).text)).toEqual({
      version: 1,
      rules: [],
    });
    expect((await run('forget', 'x')).kind).toBe('error');
  });
});
