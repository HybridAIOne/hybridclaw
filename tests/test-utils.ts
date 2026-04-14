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

type TempDirFactory = ((prefix?: string) => string) & {
  track: (dir: string | null | undefined) => void;
};

function removeTrackedDirs(tempDirs: string[]): void {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { force: true, recursive: true });
  }
}

export function useTempDir(defaultPrefix = 'hybridclaw-test-'): TempDirFactory {
  const tempDirs: string[] = [];

  afterEach(() => {
    removeTrackedDirs(tempDirs);
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
  afterEach(async () => {
    try {
      await options.cleanup?.();
    } finally {
      if (options.restoreAllMocks ?? true) {
        vi.restoreAllMocks();
      }
      if (options.unstubAllGlobals) {
        vi.unstubAllGlobals();
      }
      if (options.unstubAllEnvs) {
        vi.unstubAllEnvs();
      }
      for (const moduleId of options.unmock ?? []) {
        vi.doUnmock(moduleId);
      }
      if (options.resetModules ?? true) {
        vi.resetModules();
      }
    }
  });
}
