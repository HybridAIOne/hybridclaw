import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { setup } from './helpers/temp-root-global-setup.js';
import { useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-temp-root-regression-');

it.each([false, true])(
  'removes untracked fixtures after a run (failure=%s)',
  (fail) => {
    const sibling = makeTempDir();
    const marker = path.join(sibling, 'keep');
    fs.writeFileSync(marker, 'another run');
    const keys = ['TMPDIR', 'TMP', 'TEMP'] as const;
    const original = keys.map((key) => process.env[key]);
    const teardown = setup();
    const root = os.tmpdir();
    try {
      expect(root).not.toBe(sibling);
      for (const key of keys) expect(process.env[key]).toBe(root);
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'untracked-'));
      fs.writeFileSync(path.join(fixture, 'test.db'), 'legacy fixture');
      if (fail) throw new Error('test body failed');
    } catch (error) {
      if (
        !fail ||
        !(error instanceof Error) ||
        error.message !== 'test body failed'
      )
        throw error;
    } finally {
      teardown();
    }
    expect(fs.existsSync(root)).toBe(false);
    expect(fs.readFileSync(marker, 'utf8')).toBe('another run');
    expect(keys.map((key) => process.env[key])).toEqual(original);
  },
);
