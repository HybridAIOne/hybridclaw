import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { SECURITY_POLICY_VERSION } from '../src/config/runtime-config.ts';

// Full-binary e2e: drives the real compiled `hybridclaw gateway start` through
// a real pseudo-terminal (util-linux `script`), with Docker state faked via a
// `docker` shim on PATH. Gated behind HYBRIDCLAW_RUN_CLI_E2E=1 and Linux (for
// the `script` pty flags). Builds dist/cli.js on demand if missing.
const RUN = process.env.HYBRIDCLAW_RUN_CLI_E2E === '1';

function commandExists(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore', shell: '/bin/sh' });
    return true;
  } catch {
    return false;
  }
}

const CAN_RUN =
  RUN &&
  process.platform === 'linux' &&
  commandExists('script') &&
  commandExists('node');

const REPO = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(REPO, 'dist', 'cli.js');

let workRoot: string;
let dataDir: string;

const DAEMON_DOWN =
  'echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" 1>&2\nexit 1';
const PERMISSION_DENIED =
  'echo "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: connect: permission denied" 1>&2\nexit 1';

function fakeDockerDir(name: string, body: string): string {
  const dir = path.join(workRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, 'docker');
  fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(bin, 0o755);
  return dir;
}

function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

function runGatewayStart(opts: {
  dockerDir: string;
  input: string;
  tty: boolean;
  args?: string[];
}): string {
  const cliCmd = `exec node ${CLI} gateway start --foreground ${(opts.args ?? []).join(' ')}`.trim();
  const wrapper = path.join(workRoot, `run-${Math.abs(hashString(cliCmd))}.sh`);
  fs.writeFileSync(wrapper, `#!/bin/sh\n${cliCmd}\n`);
  fs.chmodSync(wrapper, 0o755);
  const command = opts.tty
    ? `script -qec ${wrapper} /dev/null`
    : `/bin/sh ${wrapper}`;
  const env = {
    ...process.env,
    HYBRIDCLAW_DATA_DIR: dataDir,
    PATH: `${opts.dockerDir}:${process.env.PATH ?? ''}`,
  };
  try {
    return stripAnsi(
      execSync(command, {
        env,
        shell: '/bin/sh',
        timeout: 60_000,
        encoding: 'utf-8',
        input: opts.input,
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string };
    return stripAnsi(`${err.stdout ?? ''}${err.stderr ?? ''}`);
  }
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return hash;
}

describe.skipIf(!CAN_RUN)('gateway start Docker recovery (real binary)', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      try {
        // tsc emits dist/cli.js even though a couple of optional deps lack types.
        execSync('npx tsc', { cwd: REPO, timeout: 300_000, stdio: 'ignore' });
      } catch {
        // ignore non-zero exit; existence is verified below.
      }
    }
    if (!fs.existsSync(CLI)) {
      throw new Error(`dist/cli.js not built at ${CLI}; run \`npm run build\``);
    }
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-cli-e2e-'));
    dataDir = path.join(workRoot, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    // Pre-accept the trust model so onboarding does not gate gateway start.
    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({
        security: {
          trustModelAccepted: true,
          trustModelAcceptedAt: '1970-01-01T00:00:00.000Z',
          trustModelVersion: SECURITY_POLICY_VERSION,
        },
      }),
    );
  });

  afterAll(() => {
    if (workRoot) fs.rmSync(workRoot, { recursive: true, force: true });
  });

  test('daemon down: retries, re-probes, then offers host mode on decline', () => {
    const out = runGatewayStart({
      dockerDir: fakeDockerDir('bin-down', DAEMON_DOWN),
      input: '\nn\n',
      tty: true,
    });
    expect(out).toContain("Docker is installed but the daemon isn't running");
    expect(out).toContain('Press Enter to retry');
    expect(out).toContain("Docker still isn't ready");
    expect(out).toContain('Continue without a sandbox');
    // Declined -> never switched to host mode.
    expect(out).not.toContain('Continuing in host mode');
  });

  test('daemon down: "skip" goes straight to the host-mode offer', () => {
    const out = runGatewayStart({
      dockerDir: fakeDockerDir('bin-down', DAEMON_DOWN),
      input: 'skip\nn\n',
      tty: true,
    });
    expect(out).toContain('Press Enter to retry');
    expect(out).toContain('Continue without a sandbox');
    expect(out).not.toContain('Continuing in host mode');
  });

  test('permission denied: offers host mode with a no-isolation warning', () => {
    const out = runGatewayStart({
      dockerDir: fakeDockerDir('bin-perm', PERMISSION_DENIED),
      input: 'n\n',
      tty: true,
    });
    expect(out).toContain('cannot access the Docker daemon');
    expect(out).toContain('no container isolation');
    expect(out).toContain('Continue without a sandbox');
    expect(out).not.toContain('Continuing in host mode');
  });

  test('non-interactive: recovery is skipped, no prompt is shown', () => {
    const out = runGatewayStart({
      dockerDir: fakeDockerDir('bin-down', DAEMON_DOWN),
      input: 'n\n',
      tty: false,
    });
    expect(out).toContain('Docker daemon not ready');
    expect(out).not.toContain('Press Enter to retry');
    expect(out).not.toContain('Continue without a sandbox');
  });

  test('explicit --sandbox=container: recovery is skipped, no prompt is shown', () => {
    const out = runGatewayStart({
      dockerDir: fakeDockerDir('bin-down', DAEMON_DOWN),
      input: 'n\n',
      tty: true,
      args: ['--sandbox=container'],
    });
    expect(out).toContain('Docker daemon not ready');
    expect(out).not.toContain('Press Enter to retry');
    expect(out).not.toContain('Continue without a sandbox');
  });
});
