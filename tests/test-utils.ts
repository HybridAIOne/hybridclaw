import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, vi } from 'vitest';

export interface CleanMocksOptions {
  cleanup?: () => void | Promise<void>;
  restoreAllMocks?: boolean;
  resetModules?: boolean;
  unmock?: string[];
  unstubAllEnvs?: boolean;
  unstubAllGlobals?: boolean;
}

/**
 * Kept callable so migrated tests can stay terse with `makeTempDir()`, while
 * still exposing `makeTempDir.track(dir)` for temp dirs created elsewhere.
 */
type TempDirFactory = ((prefix?: string) => string) & {
  track: (dir: string | null | undefined) => void;
};

function getCurrentWorkingDir(): string | null {
  try {
    return process.cwd();
  } catch {
    return null;
  }
}

function normalizeExistingPath(targetPath: string): string {
  try {
    return fs.realpathSync.native(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function isWithinDir(candidate: string, dir: string): boolean {
  const relative = path.relative(
    normalizeExistingPath(dir),
    normalizeExistingPath(candidate),
  );
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function chdirToSafeLocation(dir: string): void {
  for (const candidate of [os.tmpdir(), path.parse(dir).root]) {
    if (isWithinDir(candidate, dir)) continue;
    try {
      process.chdir(candidate);
      return;
    } catch {}
  }
}

function moveCwdOutOfDir(dir: string): void {
  const currentCwd = getCurrentWorkingDir();
  if (currentCwd && !isWithinDir(currentCwd, dir)) {
    return;
  }
  chdirToSafeLocation(dir);
}

function isRetryableRemoveError(
  error: unknown,
): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code !== undefined &&
    ['EBUSY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')
  );
}

function removeDirOrIgnoreMissing(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
}

export function cleanupTrackedTempDirs(tempDirs: string[]): void {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    moveCwdOutOfDir(dir);
    try {
      removeDirOrIgnoreMissing(dir);
    } catch (error) {
      if (!isRetryableRemoveError(error)) {
        throw error;
      }
      moveCwdOutOfDir(dir);
      removeDirOrIgnoreMissing(dir);
    }
  }
}

export function useTempDir(defaultPrefix = 'hybridclaw-test-'): TempDirFactory {
  const tempDirs: string[] = [];

  // If a test chdirs into a temp dir, call useTempDir() before useCleanMocks().
  // Vitest runs afterEach hooks in LIFO order, so useCleanMocks can restore cwd
  // before this temp-dir cleanup runs.
  afterEach(() => {
    cleanupTrackedTempDirs(tempDirs);
  });

  const makeTempDir = ((prefix = defaultPrefix) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }) as TempDirFactory;

  makeTempDir.track = (dir) => {
    if (!dir) return;
    tempDirs.push(dir);
  };

  return makeTempDir;
}

export function useCleanMocks(options: CleanMocksOptions = {}): void {
  const {
    cleanup,
    restoreAllMocks = false,
    resetModules = false,
    unmock = [],
    unstubAllEnvs = false,
    unstubAllGlobals = false,
  } = options;

  afterEach(async () => {
    try {
      if (restoreAllMocks) {
        vi.restoreAllMocks();
      }
      await cleanup?.();
    } finally {
      if (unstubAllGlobals) {
        vi.unstubAllGlobals();
      }
      if (unstubAllEnvs) {
        vi.unstubAllEnvs();
      }
      for (const moduleId of unmock) {
        vi.doUnmock(moduleId);
      }
      if (resetModules) {
        vi.resetModules();
      }
    }
  });
}
