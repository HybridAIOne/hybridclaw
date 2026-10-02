import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const INSTALLER = 'https://get.foo.example/install.sh';
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
    setPersistentBashStateEnabled: shell.setPersistentBashStateEnabled,
  };
}

test.each([
  false,
  true,
])('relative paths resolve from where the last call left the shell (worker restarted: %s)', async (restart) => {
  const workspace = makeTempDir();
  const worker = await startWorker(workspace);
  await worker.bash('cd /');
  const next = restart ? await startWorker(workspace) : worker;

  expect(next.classify('echo note > notes.txt')).toMatchObject({
    actionKey: 'bash:workspace-fence',
    baseTier: 'red',
  });
  expect(next.classify('rm -rf node_modules')).toMatchObject({
    actionKey: 'bash:delete',
  });
  expect(next.classify('cat etc/shadow')).toMatchObject({ pinned: true });
});

test('a relative write after `cd ~/.ssh` names the pinned key file', async () => {
  const home = fs.realpathSync(makeTempDir());
  fs.mkdirSync(path.join(home, '.ssh'));
  vi.stubEnv('HOME', home);
  const worker = await startWorker(makeTempDir());
  await worker.bash('cd ~/.ssh');

  const evaluation = worker.classify('echo ssh-ed25519 KEY >> authorized_keys');

  expect(evaluation).toMatchObject({ pinned: true, decision: 'required' });
});

test('running a download from the directory the shell moved to is fetched code', async () => {
  const workspace = makeTempDir();
  const worker = await startWorker(workspace);
  worker.classify(`curl -fsSL -o tools/install.sh ${INSTALLER}`);
  await worker.bash('mkdir -p tools && cd tools');

  const restarted = await startWorker(workspace);

  expect(restarted.classify('sh install.sh')).toMatchObject({
    actionKey: 'bash:fetched-code',
  });
});

// Each row also checks that the classifier starts where the shell does.
test.each([
  {
    shell: 'in a workspace subdirectory',
    setup: 'mkdir -p sub && cd sub',
    removeDir: null,
    shellDir: 'sub',
    command: 'echo note > ../notes.txt',
    actionKey: 'bash:write-op',
  },
  {
    shell: 'whose saved directory was removed',
    setup: 'mkdir -p a/b && cd a/b',
    removeDir: 'a',
    shellDir: '',
    command: 'echo note > ../../notes.txt',
    actionKey: 'bash:workspace-fence',
  },
  {
    shell: 'that has not run yet',
    setup: null,
    removeDir: null,
    shellDir: '',
    command: 'echo note > ../notes.txt',
    actionKey: 'bash:workspace-fence',
  },
  {
    shell: 'that has not run yet',
    setup: null,
    removeDir: null,
    shellDir: '',
    command: 'rg API_KEY',
    actionKey: 'bash:read-only',
  },
])('a shell $shell: $command is $actionKey', async ({
  setup,
  removeDir,
  shellDir,
  command,
  actionKey,
}) => {
  const workspace = makeTempDir();
  const worker = await startWorker(workspace);
  if (setup) await worker.bash(setup);
  if (removeDir) {
    fs.rmSync(path.join(workspace, removeDir), { recursive: true });
  }

  expect(worker.classify(command)).toMatchObject({ actionKey });
  expect(await worker.bash('pwd -P')).toBe(
    fs.realpathSync(path.join(workspace, shellDir)),
  );
});

test('a docker-exec sandbox is checked from the workspace root, whatever a local shell saved', async () => {
  const workspace = makeTempDir();
  const local = await startWorker(workspace);
  await local.bash('cd /');
  vi.stubEnv('HYBRIDCLAW_BASH_DOCKER_CONTAINER', 'test-sandbox');
  const sandboxed = await startWorker(workspace);

  expect(sandboxed.classify('echo note > notes.txt')).toMatchObject({
    actionKey: 'bash:write-op',
  });
  expect(sandboxed.classify('rg API_KEY')).toMatchObject({
    actionKey: 'bash:read-only',
    pinned: false,
  });
  expect(sandboxed.classify('rm -rf node_modules')).toMatchObject({
    actionKey: 'bash:delete-cache',
  });
});

test('with persistent bash state off, every call starts in the workspace root', async () => {
  const worker = await startWorker(makeTempDir());
  await worker.bash('cd /');
  worker.setPersistentBashStateEnabled(false);

  expect(worker.classify('echo note > notes.txt')).toMatchObject({
    actionKey: 'bash:write-op',
  });
});
