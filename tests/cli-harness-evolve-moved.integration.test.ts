import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';
import { useTempDir } from './test-utils.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const TSX_CLI = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI = path.join(ROOT, 'src', 'cli.ts');

const makeTempDir = useTempDir('hybridclaw-cli-moved-');

// compat: remove after v0.41, together with the `harness-evolve` case in
// src/cli.ts.
describe('hybridclaw harness-evolve (moved to the eval harness)', () => {
  test.each([
    [['harness-evolve', 'list', '--target', '.']],
    [['harness-evolve']],
    [['help', 'harness-evolve']],
  ])('%j exits 1 and points at npm run eval', (argv) => {
    const dir = makeTempDir();
    const target = path.join(dir, 'agent');
    const result = spawnSync(process.execPath, [TSX_CLI, CLI, ...argv], {
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: path.join(dir, 'home'),
        HYBRIDCLAW_DATA_DIR: path.join(dir, 'data'),
      },
      encoding: 'utf-8',
      timeout: 60_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /^hybridclaw error: .*harness-evolve.* moved .*`npm run eval -- harness-evolve`/m,
    );
    expect(result.stdout).not.toContain('Usage: hybridclaw');
    expect(fs.existsSync(target)).toBe(false);
  }, 90_000);
});
