import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const SESSION_ID = 'session-a';

const makeTempDir = useTempDir('hybridclaw-shell-cwd-');
const resetShells: Array<() => Promise<void>> = [];
useCleanMocks({
  unstubAllEnvs: true,
  resetModules: true,
  cleanup: async () => {
    for (const reset of resetShells.splice(0)) await reset();
  },
});

// A worker for the session: fresh module state over the same workspace, so a
// second call is a worker restart. `bash` runs a command in the session's
// real persistent shell; `classify` asks the approval policy about one.
async function startWorker(workspace: string) {
  vi.resetModules();
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspace);
  const { TrustedAgentApprovalRuntime } = await import(
    '../container/src/approval-policy.js'
  );
  const shell = await import('../container/src/bash-session.js');
  resetShells.push(shell.resetPersistentBashSessions);
  const runtime = new TrustedAgentApprovalRuntime(
    path.join(workspace, 'missing-policy.yaml'),
    path.join(workspace, 'agent-trust.json'),
    path.join(workspace, 'all-trust.json'),
    path.join(workspace, 'legacy-trust.json'),
    undefined,
    path.join(workspace, 'pending.json'),
  );
  runtime.setSession(SESSION_ID);
  return {
    async bash(command: string) {
      const { result } = await shell.runBash({
        command,
        timeoutMs: 10_000,
        runtimeEnv: {},
        sessionId: SESSION_ID,
      });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    },
    classify: (command: string) =>
      runtime.evaluateToolCall({
        toolName: 'bash',
        argsJson: JSON.stringify({ command }),
        latestUserPrompt: 'Tidy up the project',
      }),
  };
}

test.each([
  false,
  true,
])('every call is checked from the workspace root, where the shell starts (worker restarted: %s)', async (restart) => {
  const workspace = makeTempDir();
  const worker = await startWorker(workspace);
  await worker.bash('cd /');
  const next = restart ? await startWorker(workspace) : worker;

  expect(next.classify('echo note > notes.txt')).toMatchObject({
    actionKey: 'bash:write-op',
  });
  expect(next.classify('rm -rf node_modules')).toMatchObject({
    actionKey: 'bash:delete-cache',
  });
  expect(await next.bash('pwd -P')).toBe(fs.realpathSync(workspace));
});
