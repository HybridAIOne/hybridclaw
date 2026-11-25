import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hc-bash-session-');
let shell: typeof import('../container/src/bash-session.js') | undefined;
useCleanMocks({
  unstubAllEnvs: true,
  resetModules: true,
  cleanup: async () => {
    await shell?.resetPersistentBashSessions();
  },
});

test('persistent bash keeps command permissions and protects shell snapshots', async () => {
  const dir = makeTempDir();
  vi.stubEnv('TMPDIR', dir);
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', dir);
  vi.stubEnv('HYBRIDCLAW_AGENT_STATE_ROOT', dir);
  vi.stubEnv('HYBRIDCLAW_BASH_DOCKER_CONTAINER', '');
  const mask = process.umask(0o022);
  try {
    shell = await import('../container/src/bash-session.js');
    const run = (command: string) =>
      shell!.runBash({
        command,
        timeoutMs: 5_000,
        runtimeEnv: {},
        sessionId: 'snapshot-permissions',
      });
    expect(
      (await run('mkdir output && printf file > output/example')).result.status,
    ).toBe(0);
    expect(fs.statSync(path.join(dir, 'output')).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(dir, 'output/example')).mode & 0o777).toBe(0o644);
    expect(
      (await run('umask 000; export CHECK_STATE=preserved')).result.status,
    ).toBe(0);
    expect((await run('printf %s "$CHECK_STATE"')).result.stdout).toBe('preserved');
    const directory = fs.readdirSync(dir).find((name) =>
      name.startsWith('hybridclaw-shell-'),
    );
    const state = path.join(dir, directory ?? 'missing');
    expect(fs.statSync(state).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(state, 'state.snapshot')).mode & 0o777).toBe(0o600);
  } finally {
    process.umask(mask);
  }
});
