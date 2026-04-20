import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import * as tg from '../src/utils/type-guards.js';
import { cleanupTrackedTempDirs, useCleanMocks } from './test-utils.js';

describe('cleanupTrackedTempDirs', () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
  });

  it('covers shared type guard helpers', () => {
    expect([tg.isRecord({}), tg.ensureText(0)]).toEqual([true, '']);
    expect(tg.normalizeBaseUrl(' https://x/// ')).toBe('https://x');
  });

  it('moves cwd out of a tracked directory before deleting it', () => {
    const rootDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-test-utils-'),
    );
    const nestedDir = path.join(rootDir, 'nested');
    fs.mkdirSync(nestedDir);
    process.chdir(nestedDir);

    cleanupTrackedTempDirs([rootDir]);

    expect(fs.existsSync(rootDir)).toBe(false);
    expect(fs.realpathSync(process.cwd())).toBe(fs.realpathSync(os.tmpdir()));
  });

  it('keeps cwd unchanged when it is outside tracked directories', () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-test-utils-'),
    );

    cleanupTrackedTempDirs([tempDir]);

    expect(fs.existsSync(tempDir)).toBe(false);
    expect(process.cwd()).toBe(originalCwd);
  });

  it('ignores missing directories but still surfaces other remove failures', () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-test-utils-'),
    );

    expect(() => cleanupTrackedTempDirs([tempDir, tempDir])).not.toThrow();

    const rmSyncSpy = vi.spyOn(fs, 'rmSync').mockImplementation(() => {
      const error = new Error('permission denied') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    });

    try {
      expect(() =>
        cleanupTrackedTempDirs(['/tmp/hybridclaw-test-utils-fail']),
      ).toThrow('permission denied');
    } finally {
      rmSyncSpy.mockRestore();
    }
  });
});

describe('useCleanMocks', () => {
  const subject = {
    call: () => 'real',
  };

  let cleanupObservation: string | undefined;

  useCleanMocks({
    cleanup: () => {
      cleanupObservation = subject.call();
    },
    restoreAllMocks: true,
  });

  it('restores spies before running custom cleanup', () => {
    cleanupObservation = undefined;
    vi.spyOn(subject, 'call').mockReturnValue('mock');

    expect(subject.call()).toBe('mock');
  });

  it('runs the previous cleanup against the restored implementation', () => {
    expect(cleanupObservation).toBe('real');
  });
});
