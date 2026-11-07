import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, test } from 'vitest';
import { useTempDir } from './test-utils.ts';

// Exercise actual process termination before the CLI continues loading, with
// a package layout matching the published CLI and bundled worker entrypoints.
const makeTempDir = useTempDir('hybridclaw-nodeguard-');
let root = '';
beforeEach(() => {
  root = realpathSync(makeTempDir());
  for (const dir of [
    'dist',
    'container/shared/src',
    'container/dist',
    'scripts',
    'desktop/scripts',
  ]) {
    mkdirSync(path.join(root, dir), { recursive: true });
  }
  copyFileSync(
    'desktop/scripts/prepare-runtime.mjs',
    path.join(root, 'desktop/scripts/prepare-runtime.mjs'),
  );
  for (const name of ['node-version-guard.ts', 'node-version.ts']) {
    copyFileSync(`src/${name}`, path.join(root, 'dist', name));
  }
  copyFileSync(
    'container/src/node-version-guard.ts',
    path.join(root, 'container/dist/node-version-guard.ts'),
  );
  copyFileSync(
    'container/shared/src/node-version.ts',
    path.join(root, 'container/shared/src/node-version.ts'),
  );
  copyFileSync(
    'scripts/check-node-version.mjs',
    path.join(root, 'scripts/check-node-version.mjs'),
  );
  for (const dir of ['dist', 'container/dist']) {
    writeFileSync(
      path.join(root, dir, 'probe.ts'),
      "import './node-version-guard.ts';\nconsole.log('APPLICATION LOADED');\n",
    );
  }
});

function runProbe(range: string, entry: string) {
  for (const [dir, shared] of [
    ['', './container/shared/src/*'],
    ['container', './shared/src/*'],
  ]) {
    writeFileSync(
      path.join(root, dir, 'package.json'),
      JSON.stringify({
        type: 'module',
        engines: { node: range },
        imports: { '#shared/*': shared },
      }),
    );
  }
  return spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', path.join(root, entry)],
    {
      encoding: 'utf8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      timeout: 15_000,
    },
  );
}

const [major, minor, patch] = process.versions.node.split('.').map(Number);
const entries = [
  'dist/probe.ts',
  'container/dist/probe.ts',
  'scripts/check-node-version.mjs',
];

test.each(entries)(
  '%s rejects a missing security patch before continuing',
  (entry) => {
    const range = `>=${major}.${minor}.${patch + 1} <${major + 1}`;
    const result = runProbe(range, entry);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(range);
    expect(result.stdout).not.toContain('APPLICATION LOADED');
  },
);

test.each(entries)('%s accepts the exact minimum runtime', (entry) => {
  const result = runProbe(`>=${process.versions.node} <${major + 1}`, entry);
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  if (entry.endsWith('probe.ts'))
    expect(result.stdout).toContain('APPLICATION LOADED');
});

test.each(entries)('%s rejects a newer major', (entry) => {
  const result = runProbe(`>=${major - 1}.0.0 <${major}`, entry);
  expect(result.status).toBe(1);
  expect(result.stdout).not.toContain('APPLICATION LOADED');
});

test('desktop packaging rejects an unsupported binary before staging it', () => {
  const range = `>=${major}.${minor}.${patch + 1} <${major + 1}`;
  const result = runProbe(range, 'desktop/scripts/prepare-runtime.mjs');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(range);
  expect(existsSync(path.join(root, 'desktop/build'))).toBe(false);
});
