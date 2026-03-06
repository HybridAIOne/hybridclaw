import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { resolveContainerImageAcquisitionMode } from '../src/infra/container-setup.js';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-container-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveContainerImageAcquisitionMode', () => {
  test('prefers local builds for the default image in a git checkout', () => {
    const cwd = createTempDir();
    fs.writeFileSync(path.join(cwd, '.git'), 'gitdir: ./.git/worktrees/dev\n');

    expect(resolveContainerImageAcquisitionMode(cwd, 'hybridclaw-agent')).toBe(
      'build-only',
    );
  });

  test('allows pull fallback for packaged installs without git metadata', () => {
    const cwd = createTempDir();

    expect(resolveContainerImageAcquisitionMode(cwd, 'hybridclaw-agent')).toBe(
      'pull-or-build',
    );
  });

  test('treats explicit remote image names as pull-first', () => {
    const cwd = createTempDir();
    fs.writeFileSync(path.join(cwd, '.git'), 'gitdir: ./.git/worktrees/dev\n');

    expect(
      resolveContainerImageAcquisitionMode(
        cwd,
        'ghcr.io/hybridaione/hybridclaw-agent:latest',
      ),
    ).toBe('pull-or-build');
  });

  test('respects HYBRIDCLAW_CONTAINER_PULL_IMAGE override', () => {
    const cwd = createTempDir();
    fs.writeFileSync(path.join(cwd, '.git'), 'gitdir: ./.git/worktrees/dev\n');
    vi.stubEnv(
      'HYBRIDCLAW_CONTAINER_PULL_IMAGE',
      'ghcr.io/hybridaione/hybridclaw-agent:latest',
    );

    expect(resolveContainerImageAcquisitionMode(cwd, 'hybridclaw-agent')).toBe(
      'pull-or-build',
    );
  });

  test('builds custom local image tags locally', () => {
    const cwd = createTempDir();

    expect(resolveContainerImageAcquisitionMode(cwd, 'custom-hybridclaw')).toBe(
      'build-only',
    );
  });
});
