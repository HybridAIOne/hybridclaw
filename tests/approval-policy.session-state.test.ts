import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const INSTALLER = 'https://get.foo.example/install.sh';

const makeTempDir = useTempDir('hybridclaw-session-state-');
useCleanMocks({ unstubAllEnvs: true, resetModules: true });

// Each call starts a new worker: fresh module state over the same workspace.
async function startWorker(workspace: string, sessionId: string) {
  vi.resetModules();
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspace);
  const { TrustedAgentApprovalRuntime } = await import(
    '../container/src/approval-policy.js'
  );
  const runtime = new TrustedAgentApprovalRuntime(
    path.join(workspace, 'missing-policy.yaml'),
    path.join(workspace, 'agent-trust.json'),
    path.join(workspace, 'all-trust.json'),
    path.join(workspace, 'legacy-trust.json'),
    undefined,
    path.join(workspace, 'pending.json'),
  );
  runtime.setApprovalMode({ mode: 'full' });
  runtime.setSession(sessionId);
  return (command: string) =>
    runtime.evaluateToolCall({
      toolName: 'bash',
      argsJson: JSON.stringify({ command }),
      latestUserPrompt: 'Install the foo CLI',
    });
}

test('a download stays fetched code for its session after the worker restarts', async () => {
  const workspace = makeTempDir();
  const firstWorker = await startWorker(workspace, 'session-a');
  firstWorker(`curl -o /tmp/foo-install.sh ${INSTALLER}`);

  const restarted = await startWorker(workspace, 'session-a');
  const otherSession = await startWorker(workspace, 'session-b');

  expect(restarted('sh /tmp/foo-install.sh')).toMatchObject({
    actionKey: 'bash:fetched-code',
    decision: 'required',
  });
  expect(otherSession('sh /tmp/foo-install.sh')).toMatchObject({
    actionKey: 'bash:script',
    decision: 'approved_fullauto',
  });
});
