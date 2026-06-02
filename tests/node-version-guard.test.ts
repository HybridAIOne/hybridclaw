import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import {
  REQUIRED_NODE_MAJOR,
  checkNodeVersion,
  enforceNodeVersion,
  parseRequiredMajor,
} from '../src/node-version-guard.ts';

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { engines?: { node?: string } };

test('parses the required major from an engines.node range', () => {
  expect(parseRequiredMajor('22.x')).toBe(22);
  expect(parseRequiredMajor('>=22 <23')).toBe(22);
  expect(parseRequiredMajor('20.18.1')).toBe(20);
  expect(() => parseRequiredMajor('')).toThrow();
});

test('sources REQUIRED_NODE_MAJOR from package.json engines.node', () => {
  expect(REQUIRED_NODE_MAJOR).toBe(parseRequiredMajor(pkg.engines?.node ?? ''));
});

test('accepts a matching Node major', () => {
  expect(checkNodeVersion('22.14.0', 22)).toMatchObject({
    ok: true,
    requiredMajor: 22,
    actualMajor: 22,
  });
});

test('rejects an older Node major with a clean message', () => {
  const result = checkNodeVersion('20.18.1', 22);
  expect(result.ok).toBe(false);
  expect(result.actualMajor).toBe(20);
  expect(result.message).toContain('requires Node.js 22.x');
  expect(result.message).toContain('20.18.1');
});

test('rejects a newer Node major as well', () => {
  expect(checkNodeVersion('24.0.0', 22)).toMatchObject({
    ok: false,
    actualMajor: 24,
  });
});

test('accepts a v-prefixed version string', () => {
  expect(checkNodeVersion('v22.1.0', 22)).toMatchObject({
    ok: true,
    actualMajor: 22,
  });
});

test('treats an unparseable version as major 0', () => {
  expect(checkNodeVersion('not-a-version', 22)).toMatchObject({
    ok: false,
    actualMajor: 0,
  });
});

test('enforceNodeVersion reports the message and exits 1 on a bad runtime', () => {
  const errors: string[] = [];
  const exitCodes: number[] = [];
  enforceNodeVersion(
    checkNodeVersion('20.18.1', 22),
    (message) => errors.push(message),
    (code) => exitCodes.push(code),
  );
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain('requires Node.js 22.x');
  expect(exitCodes).toEqual([1]);
});

test('enforceNodeVersion is a no-op on a supported runtime', () => {
  const errors: string[] = [];
  const exitCodes: number[] = [];
  enforceNodeVersion(
    checkNodeVersion('22.0.0', 22),
    (message) => errors.push(message),
    (code) => exitCodes.push(code),
  );
  expect(errors).toEqual([]);
  expect(exitCodes).toEqual([]);
});

test('cli.ts imports the version guard before any other module', () => {
  const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const firstImport = cli.match(/^import\b.*$/m)?.[0];
  expect(firstImport).toBe("import './node-version-guard.js';");
});
