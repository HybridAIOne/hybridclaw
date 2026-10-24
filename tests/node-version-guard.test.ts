import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { parseNodeRange } from '../container/shared/node-version.js';
import { enforceNodeVersion } from '../src/node-version-guard.ts';
import { REQUIRED_NODE_RANGE, checkNodeVersion } from '../src/node-version.ts';

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

test('sources the supported range from package.json', () => {
  expect(REQUIRED_NODE_RANGE).toBe(pkg.engines.node);
  expect(parseNodeRange(REQUIRED_NODE_RANGE)).toEqual({
    minimum: '22.23.4',
    major: 22,
  });
});

test.each(['', '22.x', '>=22', '>=22.23.4 <24', '>=22.23.4 <23 || >=24'])(
  'fails closed on unsupported range %s',
  (range) => {
    expect(() => parseNodeRange(range)).toThrow();
  },
);

test.each([
  ['22.23.3', false],
  ['22.22.99', false],
  ['20.19.0', false],
  ['22.23.4', true],
  ['v22.23.4', true],
  ['22.23.5', true],
  ['22.24.0', true],
  ['23.0.0', false],
  ['24.0.0', false],
  ['22.23.4-rc.1', false],
  ['22.23.4junk', false],
  ['22.23', false],
  ['22.023.4', false],
  ['not-a-version', false],
])('checks complete stable version %s', (version, ok) => {
  const check = checkNodeVersion(version);
  expect(check.ok).toBe(ok);
  if (!ok) {
    expect(check.message).toContain(REQUIRED_NODE_RANGE);
    expect(check.message).toContain(version);
  }
});

test.each([
  ['22.23.3', [1]],
  ['22.23.4', []],
] as const)('enforces %s with the right exit status', (version, expected) => {
  const errors: string[] = [];
  const codes: number[] = [];
  enforceNodeVersion(
    checkNodeVersion(version),
    (message) => errors.push(message),
    (code) => codes.push(code),
  );
  expect(codes).toEqual(expected);
  expect(errors).toHaveLength(expected.length);
});

test.each(['src/cli.ts', 'container/src/index.ts'])(
  '%s imports its version guard first',
  (file) => {
    const firstImport = readFileSync(file, 'utf8').match(/^import\b.*$/m)?.[0];
    expect(firstImport).toBe("import './node-version-guard.js';");
  },
);

test('generated Node requirements and pins have no drift', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/sync-package-versions.mjs', '--check'],
    { encoding: 'utf8', timeout: 15_000 },
  );
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
});
