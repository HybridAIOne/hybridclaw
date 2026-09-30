import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-shrinkwrap-sync-');
const script = path.resolve('scripts/sync-shrinkwraps.mjs');

describe('dependency lock synchronization', () => {
  it('preserves npm-updated shrinkwraps over stale lockfiles', () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, 'container'));
    for (const component of ['', 'container']) {
      const base = path.join(dir, component);
      fs.writeFileSync(path.join(base, 'npm-shrinkwrap.json'), '{"version":"2.0.0"}\n');
      fs.writeFileSync(path.join(base, 'package-lock.json'), '{"version":"1.0.0"}\n');
    }

    const result = spawnSync(process.execPath, [script], {
      cwd: dir,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    for (const component of ['', 'container']) {
      const base = path.join(dir, component);
      expect(fs.readFileSync(path.join(base, 'package-lock.json'), 'utf8')).toBe(
        '{"version":"2.0.0"}\n',
      );
      expect(fs.readFileSync(path.join(base, 'npm-shrinkwrap.json'), 'utf8')).toBe(
        '{"version":"2.0.0"}\n',
      );
    }
  });

  it('fails when npm has not produced a shrinkwrap', () => {
    const dir = makeTempDir();
    const lock = path.join(dir, 'package-lock.json');
    fs.writeFileSync(lock, '{"version":"1.0.0"}\n');

    const result = spawnSync(process.execPath, [script], {
      cwd: dir,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(fs.readFileSync(lock, 'utf8')).toBe('{"version":"1.0.0"}\n');
  });
});
