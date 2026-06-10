import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, test } from 'vitest';
import {
  CONTAINER_PREFIX,
  cleanupStaleContainers,
} from './helpers/docker-test-setup.js';

/**
 * End-to-end coverage for the `curl | bash` bootstrap installer
 * (scripts/install.sh), exercised inside throwaway Docker containers — the
 * same matrix a maintainer would run by hand before publishing a release.
 *
 * Each case mounts the *working-tree* copy of install.sh (so it tests local
 * edits, not the version on `main`) read-only at /tmp/install.sh and runs it
 * against a deliberately bare base image. The scenarios pin three behaviours
 * that have regressed before:
 *
 *   1. Managed-Node path needs no `xz`: nodejs.org's tarball is fetched as
 *      .tar.gz and extracted with `tar -xzf`, so a minimal Debian/Ubuntu box
 *      (no xz-utils) installs cleanly instead of dying in `tar -xJf`.
 *   2. System-Node + root-owned global prefix installs with no sudo: the
 *      EACCES fallback repoints npm at ~/.hybridclaw/npm-global without ever
 *      escalating or mutating the system prefix.
 *   3. musl libc (Alpine) is refused up front with an actionable hint rather
 *      than downloading an incompatible glibc Node.
 *
 * Heavy: each "real install" case downloads Node and runs a full global
 * `npm install` of the published CLI (~6-7 min total). This file lives in its
 * own `install-e2e` vitest project (see vitest.config.ts), so the several CI
 * jobs that run `vitest run --project e2e` never pull it in — no opt-in env var
 * needed. Run it with `npm run test:install-e2e` (or `--project install-e2e`).
 * It self-selects on a reachable Docker daemon and skips otherwise. Override the
 * installed version (default: latest) with HYBRIDCLAW_E2E_INSTALL_VERSION.
 */

function dockerAvailable(): boolean {
  const r = spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 15_000 });
  return r.status === 0;
}

const ENABLED = dockerAvailable();

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = path.join(REPO, 'scripts', 'install.sh');
const INSTALL_VERSION = process.env.HYBRIDCLAW_E2E_INSTALL_VERSION ?? 'latest';

// Per single install attempt. The "real install" cases pull ~650 npm packages
// over the network, so the vitest test timeout below leaves room for one retry.
const INSTALL_ATTEMPT_MS = 300_000;
const INSTALL_TEST_MS = 660_000;
const QUICK_TIMEOUT_MS = 150_000;

// npm registry reads flake intermittently (ETIMEDOUT/ECONNRESET) on a fat
// install; that is infrastructure noise, not an installer bug. Retry the whole
// container run a bounded number of times — but only on a network signature, so
// a genuine logic failure still fails fast on the first attempt.
const NETWORK_ERROR =
  /ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EINTEGRITY|ERR_SOCKET_TIMEOUT|fetch failed|503 Service Unavailable|Temporary failure|Hash Sum mismatch|network (?:read|connectivity|request)/i;

interface ContainerRun {
  status: number;
  output: string;
}

/**
 * Run a shell snippet inside a fresh `--rm` container with install.sh mounted
 * read-only at /tmp/install.sh. stdout and stderr are merged so assertions can
 * match on either (the installer writes warnings/errors to stderr).
 */
function runInContainer(opts: {
  image: string;
  script: string;
  user?: string;
  shell?: 'bash' | 'sh';
  timeoutMs?: number;
}): ContainerRun {
  const { image, script, user, shell = 'bash', timeoutMs } = opts;
  // --init: without it the shell is PID 1 and ignores the SIGTERM that
  // spawnSync's timeout sends, so a timed-out install keeps running (and
  // --rm never fires) — orphaned containers pile up across retries.
  // The name gives the stale-container sweeper a handle for anything that
  // survives a SIGKILLed worker.
  const args = [
    'run',
    '--rm',
    '--init',
    '--name',
    `${CONTAINER_PREFIX}-install-${randomUUID()}`,
  ];
  if (user) args.push('--user', user);
  args.push(
    '--volume',
    `${SCRIPT}:/tmp/install.sh:ro`,
    image,
    shell,
    '-c',
    script,
  );
  const r = spawnSync('docker', args, {
    encoding: 'utf-8',
    timeout: timeoutMs ?? INSTALL_ATTEMPT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error && (r.error as NodeJS.ErrnoException).code !== 'ETIMEDOUT') {
    throw new Error(`docker run failed to start: ${r.error.message}`);
  }
  // status is null when the process is killed (e.g. by the timeout); surface
  // that as a non-zero sentinel so the assertion fails loudly rather than
  // throwing on a null comparison.
  return { status: r.status ?? -1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/**
 * Like runInContainer, but retries on transient npm/network failures (up to
 * `attempts` total). A non-network failure returns immediately so real bugs are
 * not masked by retrying.
 */
function runInstall(
  opts: Parameters<typeof runInContainer>[0],
  attempts = 2,
): ContainerRun {
  let last: ContainerRun | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    last = runInContainer(opts);
    // status -1 is the spawnSync timeout kill: usually a slow network, and the
    // truncated output rarely contains a network signature — retry it too.
    const transient = NETWORK_ERROR.test(last.output) || last.status === -1;
    if (last.status === 0 || !transient) return last;
    if (attempt < attempts) {
      console.warn(
        `[install-e2e] transient failure on ${opts.image} (attempt ${attempt}/${attempts}); retrying`,
      );
    }
  }
  return last as ContainerRun;
}

// In CI this suite is the only thing exercising the installer matrix; a
// Docker outage must fail the job loudly instead of skipping it green.
// Value-aware like install.sh's own CI parsing: CI=false/0 is not CI.
const IN_CI = !!process.env.CI && !/^(false|no|off|0)$/i.test(process.env.CI);
if (!ENABLED && IN_CI) {
  test('docker daemon is required for the installer e2e suite in CI', () => {
    throw new Error(
      'docker info failed: the installer bootstrap matrix cannot run. ' +
        'Fix the runner Docker daemon rather than letting this suite skip silently.',
    );
  });
}

describe.skipIf(!ENABLED)('install.sh bootstrap (Docker)', () => {
  beforeAll(() => {
    cleanupStaleContainers('install');
  });

  test(
    'clean Debian/Ubuntu without xz: managed Node via gzip tarball, then CLI install',
    () => {
      const { status, output } = runInstall({
        image: 'ubuntu:24.04',
        script: [
          'set -e',
          // stdout silenced for noise, stderr kept: an apt mirror flake must
          // surface its own diagnostics (and match the transient-retry regex)
          // instead of failing the later assertions with no clue.
          'apt-get update -qq >/dev/null',
          // curl + ca-certificates is the floor a `curl | bash` user already
          // meets; python3/make/g++ let native modules compile. We pointedly do
          // NOT install xz-utils — the managed-Node path must not need it.
          'apt-get install -y -qq curl ca-certificates python3 make g++ >/dev/null',
          'export npm_config_fetch_retries=5',
          `bash /tmp/install.sh --no-prompt --verify --version ${INSTALL_VERSION}`,
        ].join('\n'),
      });

      // Regression guards for the two bugs this path used to hit.
      expect(output).not.toMatch(/xz: Cannot exec/);
      expect(output).not.toMatch(/unbound variable/);
      // Proof the download + checksum + extract stage actually ran.
      expect(output).toContain('Verified Node.js download (sha256)');
      expect(output).toMatch(/hybridclaw --version -> \d+\.\d+\.\d+/);
      expect(status).toBe(0);
    },
    INSTALL_TEST_MS,
  );

  test(
    'system Node 22, non-root, root-owned prefix: no-sudo fallback, bundled npm as-is',
    () => {
      const { status, output } = runInstall({
        image: 'node:22',
        user: 'node',
        script: [
          'export npm_config_fetch_retries=5',
          'bash /tmp/install.sh --no-prompt --verify',
          'echo "PREFIX=$(npm config get prefix)"',
          'grep -qs "added by HybridClaw installer" "$HOME/.bashrc" "$HOME/.profile" && echo RC_PERSISTED=yes || echo RC_PERSISTED=no',
        ].join('\n'),
      });

      // EACCES on the root-owned /usr/local prefix → user-local prefix, no sudo.
      expect(output).toMatch(
        /not writable; using .*npm-global instead \(no sudo\)/,
      );
      expect(output).toContain('PREFIX=/home/node/.hybridclaw/npm-global');
      // The bundled npm is used as-is (no forced upgrade — the published
      // shrinkwrap pins the tree, so any Node 22 npm installs it correctly).
      expect(output).toMatch(/npm \d+\.\d+\.\d+ detected/);
      expect(output).toMatch(/hybridclaw --version -> \d+\.\d+\.\d+/);
      // PATH persistence must land in an rc file, not just this process's env
      // (the in-process --verify above cannot see a broken rc write).
      expect(output).toContain('RC_PERSISTED=yes');
      expect(status).toBe(0);
    },
    INSTALL_TEST_MS,
  );

  test(
    'musl libc (Alpine) is refused with a --skip-node hint, no partial install',
    () => {
      const { status, output } = runInContainer({
        image: 'alpine:3.20',
        shell: 'sh',
        timeoutMs: QUICK_TIMEOUT_MS,
        script: [
          // stderr kept so an apk/CDN flake explains itself in the output.
          'apk add --no-cache bash curl >/dev/null',
          'bash /tmp/install.sh --no-prompt',
          'rc=$?',
          'echo "HOME_EXISTS=$([ -e "$HOME/.hybridclaw" ] && echo yes || echo no)"',
          'exit $rc',
        ].join('\n'),
      });

      expect(output).toMatch(/musl/i);
      expect(output).toContain('--skip-node');
      // The title's promise: the musl refusal must leave nothing behind.
      expect(output).toContain('HOME_EXISTS=no');
      expect(status).not.toBe(0);
    },
    QUICK_TIMEOUT_MS,
  );

  test(
    '--dry-run prints the plan and touches nothing',
    () => {
      const { status, output } = runInContainer({
        image: 'ubuntu:24.04',
        timeoutMs: QUICK_TIMEOUT_MS,
        script: [
          'apt-get update -qq >/dev/null 2>&1',
          'apt-get install -y -qq curl ca-certificates >/dev/null 2>&1',
          'bash /tmp/install.sh --dry-run --no-prompt',
          'echo "HOME_EXISTS=$([ -e "$HOME/.hybridclaw" ] && echo yes || echo no)"',
        ].join('\n'),
      });

      expect(output).toContain('[dry-run]');
      expect(output).toContain('HOME_EXISTS=no');
      expect(status).toBe(0);
    },
    QUICK_TIMEOUT_MS,
  );
});
