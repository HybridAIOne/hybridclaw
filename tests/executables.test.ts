import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

const tempDirs: string[] = [];
const originalPath = process.env.PATH;
const originalPathExt = process.env.PATHEXT;

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeExecutable(dir: string, relativePath: string): string {
  const absolutePath = path.join(dir, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, '#!/bin/sh\nexit 0\n', 'utf-8');
  fs.chmodSync(absolutePath, 0o755);
  return absolutePath;
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
  if (originalPathExt === undefined) {
    delete process.env.PATHEXT;
  } else {
    process.env.PATHEXT = originalPathExt;
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('finds bare executables on PATH when they appear later under the same PATH', async () => {
  const dir = makeTempDir('hybridclaw-exec-path-');
  const binaryName = 'demo-exec';
  const { hasExecutableCommand } = await import('../src/utils/executables.js');
  vi.stubEnv('PATH', dir);
  expect(hasExecutableCommand(binaryName)).toBe(false);

  writeExecutable(dir, binaryName);
  expect(hasExecutableCommand(binaryName)).toBe(true);
});

test('resolves relative executable paths against the provided cwd', async () => {
  const cwd = makeTempDir('hybridclaw-exec-cwd-');
  const relativePath = path.join('bin', 'local-exec');
  writeExecutable(cwd, relativePath);

  const { hasExecutableCommand } = await import('../src/utils/executables.js');
  expect(hasExecutableCommand(relativePath, { cwd })).toBe(true);
  expect(
    hasExecutableCommand(relativePath, {
      cwd: makeTempDir('hybridclaw-exec-other-'),
    }),
  ).toBe(false);
});
