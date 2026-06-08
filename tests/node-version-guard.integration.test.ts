import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, test } from 'vitest';

// End-to-end check of the real guard in a separate Node process. The layout
// mirrors the published package (package.json at the root, the guard one level
// down under dist/), and engines.node is pointed at a major other than the
// runner's so the guard trips on the *current* Node. This exercises the real
// process exit, the package.json read, and the import-ordering halt together —
// the parts the in-process unit tests cannot reach on a supported runtime.

const guardSource = fileURLToPath(
  new URL('../src/node-version-guard.ts', import.meta.url),
);

let root = '';

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'hybridclaw-nodeguard-'));
  mkdirSync(path.join(root, 'dist'));
  copyFileSync(guardSource, path.join(root, 'dist', 'node-version-guard.ts'));
  writeFileSync(
    path.join(root, 'dist', 'probe.ts'),
    "import './node-version-guard.ts';\nconsole.log('HEAVY GRAPH RAN');\n",
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function runProbe(enginesNode: string) {
  writeFileSync(
    path.join(root, 'package.json'),
    `${JSON.stringify({ type: 'module', engines: { node: enginesNode } })}\n`,
  );
  return spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', path.join(root, 'dist', 'probe.ts')],
    { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } },
  );
}

test('exits before the rest of the CLI loads on an unsupported Node major', () => {
  // The test runner is not Node 18, so requiring 18.x trips the guard.
  const result = runProbe('18.x');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('requires Node.js 18.x');
  expect(result.stdout).not.toContain('HEAVY GRAPH RAN');
});

test('continues loading when the running Node matches engines.node', () => {
  const runningMajor = process.versions.node.split('.')[0];
  const result = runProbe(`${runningMajor}.x`);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('HEAVY GRAPH RAN');
});
