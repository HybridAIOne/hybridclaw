import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { cleanupTrackedTempDirs } from './test-utils.js';

describe('cleanupTrackedTempDirs', () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
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
});
