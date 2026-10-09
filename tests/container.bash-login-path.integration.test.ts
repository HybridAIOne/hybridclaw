import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

/**
 * The agent's real bash invocation (`bash -lc` + wrapper) under a login
 * profile that resets PATH the way Debian's /etc/profile does. The worker's
 * PATH entries the profile dropped come back after the profile's own.
 */

const PROBE = 'hybridclaw-login-path-probe';
const PROFILE_PATH = '/usr/bin:/bin';

describe.sequential('bash login shells keep the worker PATH', () => {
  const makeTempDir = useTempDir('hybridclaw-bash-login-path-');
  let tools: typeof import('../container/src/tools.js') | null = null;
  useCleanMocks({
    unstubAllEnvs: true,
    resetModules: true,
    cleanup: async () => {
      await tools?.resetPersistentBashSessions();
      tools = null;
    },
  });

  async function setup(persistBashState: boolean) {
    const root = makeTempDir();
    const home = path.join(root, 'home');
    const workerBin = path.join(root, 'worker bin');
    const workspace = path.join(root, 'workspace');
    for (const dir of [home, workerBin, workspace]) fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(home, '.bash_profile'),
      `PATH="${PROFILE_PATH}"\nexport PATH\n`,
    );
    fs.writeFileSync(path.join(workerBin, PROBE), '#!/bin/sh\necho probe-ok\n', {
      mode: 0o755,
    });
    vi.stubEnv('HOME', home);
    vi.stubEnv('PATH', `${workerBin}:${PROFILE_PATH}:${process.env.PATH}`);
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspace);
    tools = await import('../container/src/tools.js');
    tools.setPersistentBashStateEnabled(persistBashState);
    tools.setSessionContext(`bash-login-path-${persistBashState}`);
    const bash = (command: string) =>
      tools!.executeTool('bash', JSON.stringify({ command }));
    return { bash, workerBin };
  }

  test.each([
    false,
    true,
  ])('a command resolves a worker PATH entry the profile reset dropped (persistent=%s)', async (persistBashState) => {
    const { bash, workerBin } = await setup(persistBashState);
    const output = await bash(`${PROBE} && printf '%s' "$PATH"`);
    const [probe, shellPath] = output.split('\n');
    expect(probe).toBe('probe-ok');
    const entries = shellPath.split(':');
    // The profile's entries keep their precedence; nothing is duplicated.
    expect(entries.slice(0, 2)).toEqual(PROFILE_PATH.split(':'));
    expect(entries.filter((entry) => entry === workerBin)).toHaveLength(1);
    expect(entries.filter((entry) => entry === '/usr/bin')).toHaveLength(1);
    expect(entries).not.toContain('');
    expect(await bash(PROBE)).toBe('probe-ok\n');
  });

  test('a PATH the agent exports in a persistent shell is kept as set', async () => {
    const { bash } = await setup(true);
    expect(await bash(PROBE)).toBe('probe-ok\n');
    await bash(`export PATH="${PROFILE_PATH}"`);
    expect(await bash(`printf '%s' "$PATH"`)).toBe(PROFILE_PATH);
  });
});
