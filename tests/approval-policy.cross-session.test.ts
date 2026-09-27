import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { TrustedAgentApprovalRuntime } from '../container/src/approval-policy.js';
import { useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-cross-session-');

type StorePaths = ConstructorParameters<typeof TrustedAgentApprovalRuntime>;

// Workers of one agent share its workspace, and with it these store files.
function agentWorkspace(): StorePaths {
  const dir = makeTempDir();
  return [
    path.join(dir, 'missing-policy.yaml'),
    path.join(dir, 'agent-trust.json'),
    path.join(dir, 'all-trust.json'),
    path.join(dir, 'legacy-trust.json'),
    undefined,
    path.join(dir, 'pending.json'),
  ];
}

// A worker that starts now: a fresh runtime on the shared workspace.
function startWorker(
  workspace: StorePaths,
  sessionId: string,
): TrustedAgentApprovalRuntime {
  const runtime = new TrustedAgentApprovalRuntime(...workspace);
  runtime.setSession(sessionId);
  return runtime;
}

function requestApproval(runtime: TrustedAgentApprovalRuntime, command: string) {
  const evaluation = runtime.evaluateToolCall({
    toolName: 'bash',
    argsJson: JSON.stringify({ command }),
    latestUserPrompt: `Please run ${command}`,
  });
  expect(evaluation.decision).toBe('required');
  return evaluation;
}

function reply(runtime: TrustedAgentApprovalRuntime, text: string) {
  return runtime.handleApprovalResponse([{ role: 'user', content: text }]);
}

const DEPLOY = 'bash ./deploy.sh';
const deployCall = { toolName: 'bash', argsJson: JSON.stringify({ command: DEPLOY }) };

describe('pending approvals stay with the session that asked', () => {
  test.each([
    'yes',
    'y',
    'approve',
    'Thanks, that helps.\nyes',
  ])('%j in another session leaves the request pending', (text) => {
    const workspace = agentWorkspace();
    requestApproval(startWorker(workspace, 'session-a'), DEPLOY);

    expect(reply(startWorker(workspace, 'session-b'), text)).toBeNull();
    expect(
      reply(startWorker(workspace, 'session-a'), 'yes')?.approvedToolCall,
    ).toEqual(deployCall);
  });

  test("another session cannot approve a request by naming its id", () => {
    const workspace = agentWorkspace();
    const request = requestApproval(startWorker(workspace, 'session-a'), DEPLOY);
    const sessionB = startWorker(workspace, 'session-b');

    expect(reply(sessionB, `yes ${request.requestId}`)).toBeNull();
    requestApproval(sessionB, 'bash ./cleanup.sh');
    const named = reply(sessionB, `yes ${request.requestId} for agent`);
    expect(named?.approvedToolCall).toBeUndefined();
    expect(named?.immediateMessage).toContain(String(request.requestId));

    expect(
      reply(startWorker(workspace, 'session-a'), `yes ${request.requestId}`)
        ?.approvedToolCall,
    ).toEqual(deployCall);
  });

  test("the pending limit counts only the session's own requests", () => {
    const workspace = agentWorkspace();
    const sessionA = startWorker(workspace, 'session-a');
    for (const script of ['one', 'two', 'three']) {
      requestApproval(sessionA, `bash ./${script}.sh`);
    }

    requestApproval(startWorker(workspace, 'session-b'), DEPLOY);
  });

  test("saving one session's requests keeps other sessions' requests as they are", () => {
    const workspace = agentWorkspace();
    const sessionA = startWorker(workspace, 'session-a');
    requestApproval(sessionA, DEPLOY);
    const sessionB = startWorker(workspace, 'session-b');

    expect(reply(sessionA, 'yes')?.approvedToolCall).toEqual(deployCall);
    requestApproval(sessionB, 'bash ./cleanup.sh');

    expect(reply(startWorker(workspace, 'session-a'), 'yes')).toBeNull();
    expect(
      reply(startWorker(workspace, 'session-b'), 'yes')?.approvedToolCall,
    ).toEqual({
      toolName: 'bash',
      argsJson: JSON.stringify({ command: 'bash ./cleanup.sh' }),
    });
  });

  test('a saved request without a session belongs to no session', () => {
    const workspace = agentWorkspace();
    const now = Date.now();
    fs.writeFileSync(
      String(workspace[5]),
      JSON.stringify({
        version: 1,
        pending: [
          {
            id: 'abc12345',
            fingerprint: 'saved-fingerprint',
            actionKey: 'bash:script',
            toolName: 'bash',
            argsJson: deployCall.argsJson,
            intent: `run script \`${DEPLOY}\``,
            consequenceIfDenied: 'I will avoid executing unknown scripts.',
            reason: 'script execution is treated as high risk',
            commandPreview: DEPLOY,
            createdAtMs: now,
            expiresAtMs: now + 60_000,
            originalPrompt: `Please run ${DEPLOY}`,
            pinned: false,
          },
        ],
        updatedAt: new Date(now).toISOString(),
      }),
    );

    expect(reply(startWorker(workspace, 'session-a'), 'yes')).toBeNull();
  });
});
