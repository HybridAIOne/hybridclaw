import fs from 'node:fs';
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

async function fetchedStatePath() {
  const { sessionStatePath } = await import(
    '../container/src/session-state.js'
  );
  return sessionStatePath('session-a', 'fetched-files.json');
}

test.each([
  '{bad json',
  'null',
  JSON.stringify({ version: 2, values: [] }),
  JSON.stringify({ version: 1, values: [42] }),
])(
  'refuses a replacement worker with invalid fetched-code state: %s',
  async (contents) => {
    const workspace = makeTempDir();
    const first = await startWorker(workspace, 'session-a');
    first(`curl -o /tmp/foo-install.sh ${INSTALLER}`);
    fs.writeFileSync(await fetchedStatePath(), contents);
    await expect(startWorker(workspace, 'session-a')).rejects.toThrow();
  },
);

test('refuses a replacement worker when fetched-code state cannot be read', async () => {
  const workspace = makeTempDir();
  const first = await startWorker(workspace, 'session-a');
  first(`curl -o /tmp/foo-install.sh ${INSTALLER}`);
  const statePath = await fetchedStatePath();
  fs.rmSync(statePath);
  fs.mkdirSync(statePath);
  await expect(startWorker(workspace, 'session-a')).rejects.toThrow();
});

test('refuses the download when its guard cannot persist and latches the failure', async () => {
  const workspace = makeTempDir();
  const first = await startWorker(workspace, 'session-a');
  const statePath = await fetchedStatePath();
  fs.mkdirSync(statePath, { recursive: true });
  expect(first(`curl -o /tmp/foo-install.sh ${INSTALLER}`)).toMatchObject({
    decision: 'denied',
  });
  fs.rmSync(statePath, { recursive: true });
  expect(first(`curl -o /tmp/another-install.sh ${INSTALLER}`)).toMatchObject({
    decision: 'denied',
  });
});
